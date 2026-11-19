import { formatUnits, keccak256, toBytes } from "viem";
import { config, type Hex } from "./config.ts";
import { escrowAbi } from "./abi.ts";
import { Signer, escrowAddress, readJob, readParams, findProofUrl, jobCreatedAt, publicClient, proofSubmittedEvent, getLogsChunked, errMsg } from "./chain.ts";
import { fetchProof } from "./proof.ts";
import { runRules, detectInjection, judgeWithLlm, decide, buildReceiptBody, type Receipt } from "./verify.ts";
import type { LLMProvider } from "./llm.ts";
import type { Store } from "./store.ts";

export type Log = (msg: string) => void;

/**
 * The verification agent. It holds ONLY the agent key, which on-chain can do exactly two things:
 * agentRelease / agentReject on a job that already has proof, bound to that proof's hash, under a cap.
 */
export class VerifierAgent {
  private inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;
  private store: Store;
  private llm: LLMProvider | null;
  private signer: Signer | null;
  private log: Log;
  constructor(store: Store, llm: LLMProvider | null, signer: Signer | null, log: Log = (m) => console.log(`[agent] ${m}`)) {
    this.store = store;
    this.llm = llm;
    this.signer = signer;
    this.log = log;
  }

  get address(): Hex | undefined {
    return this.signer?.address;
  }

  /** Idempotent: safe to call many times for the same job; acts at most once per proof. */
  async processJob(jobId: bigint): Promise<Receipt | undefined> {
    const key = jobId.toString();
    if (this.inFlight.has(key)) return undefined;
    this.inFlight.add(key);
    try {
      const job = await readJob(jobId);
      if (job.status !== "ProofSubmitted") return undefined;
      const rec = this.store.job(jobId);
      // Already decided on this exact proof? (e.g. needs_human) -> don't spam.
      const last = rec.receipts.at(-1);
      if (last && last.body.proofHash.toLowerCase() === job.proofHash.toLowerCase() && (last.action === "none" || last.txHash)) return undefined;

      this.store.updateJob(jobId, { agentState: "verifying", agentNote: "Fetching proof and checking it against the brief..." });
      let proofUrl = rec.proofUrl;
      if (!proofUrl || keccak256(toBytes(proofUrl)).toLowerCase() !== job.proofHash.toLowerCase()) {
        proofUrl = (await findProofUrl(jobId, job.proofHash, job.proofSubmittedAt))?.url;
        if (!proofUrl) throw new Error("Could not find the submitted proof URL in chain logs");
        this.store.updateJob(jobId, { proofUrl });
      }
      const brief = this.store.getBrief(job.briefHash);
      if (!brief) {
        this.store.updateJob(jobId, { agentState: "needs_human", agentNote: "The brief for this job is unknown to this agent (brief hash not registered). Client must review." });
        return undefined;
      }
      const params = await readParams();
      if (params.paused) {
        this.store.updateJob(jobId, { agentState: "needs_human", agentNote: "Agent actions are paused by the owner. Client can approve manually." });
        return undefined;
      }

      const proof = await fetchProof(proofUrl);
      const createdAt = await jobCreatedAt(jobId).catch(() => undefined);
      const checks = runRules(brief, proof, { jobCreatedAt: createdAt ?? brief.createdAt, submittedAt: Number(job.proofSubmittedAt) });
      const injectionFlags = proof.ok ? detectInjection(proof.text) : [];
      const hardFail = checks.some((c) => c.hard && !c.pass);
      const llm = !hardFail && this.llm ? await judgeWithLlm(this.llm, brief, proof) : undefined;
      const { decision, reasoning } = decide(checks, injectionFlags, llm, {
        minConfidence: config.minConfidence,
        allowRulesOnlyRelease: config.allowRulesOnlyRelease,
        amountBaseUnits: job.amount,
        agentReleaseCap: params.agentReleaseCap,
      });
      const { body, receiptHash } = buildReceiptBody({
        chainId: config.chainId,
        escrow: escrowAddress(),
        token: config.tokenAddress,
        jobId: key,
        client: job.client,
        payee: job.payee,
        amount: formatUnits(job.amount, config.tokenDecimals),
        briefHash: job.briefHash,
        proofUrl,
        proofHash: job.proofHash,
        proofContentHash: proof.contentHash,
        proofSnapshot: { author: proof.author, createdAt: proof.createdAt, title: proof.title, excerpt: proof.text.slice(0, 500), fetchedAt: proof.fetchedAt, error: proof.error },
        checks,
        injectionFlags,
        llm,
        decision,
        reasoning,
        decidedAt: Math.floor(Date.now() / 1000),
      });
      const receipt: Receipt = { body, receiptHash, action: "none" };
      this.log(`job ${key}: ${decision} — ${reasoning}`);

      if (decision === "needs_human" || !this.signer) {
        receipt.action = "none";
        this.store.addReceipt(jobId, receipt);
        this.store.updateJob(jobId, { agentState: "needs_human", agentNote: this.signer ? reasoning : `${reasoning} (agent key not configured: read-only mode)` });
        return receipt;
      }
      // Re-read status right before acting (another actor may have released/refunded meanwhile).
      const fresh = await readJob(jobId);
      if (fresh.status !== "ProofSubmitted" || fresh.proofHash !== job.proofHash) return undefined;
      const fn = decision === "release" ? "agentRelease" : "agentReject";
      receipt.action = fn;
      try {
        const tx = await this.signer.write({ address: escrowAddress(), abi: escrowAbi, functionName: fn, args: [jobId, job.proofHash, receiptHash] });
        receipt.txHash = tx.hash;
        receipt.blockNumber = tx.blockNumber.toString();
        this.store.addReceipt(jobId, receipt);
        this.store.updateJob(jobId, { agentState: "done", agentNote: reasoning, lastActionTx: tx.hash });
      } catch (e) {
        receipt.error = errMsg(e);
        this.store.addReceipt(jobId, receipt);
        this.store.updateJob(jobId, { agentState: "error", agentNote: `On-chain ${fn} failed: ${receipt.error}` });
      }
      return receipt;
    } catch (e) {
      this.store.updateJob(jobId, { agentState: "error", agentNote: errMsg(e) });
      this.log(`job ${key}: error ${errMsg(e)}`);
      return undefined;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Poll ProofSubmitted logs (chunked) and process any job waiting for a verdict. */
  async tick(): Promise<void> {
    const latest = await publicClient.getBlockNumber();
    const from = this.store.lastScannedBlock !== undefined ? this.store.lastScannedBlock + 1n : (config.startBlock ?? (latest > 2000n ? latest - 2000n : 0n));
    if (from > latest) return;
    const logs = await getLogsChunked(
      (f, t) => publicClient.getLogs({ address: escrowAddress(), event: proofSubmittedEvent, fromBlock: f, toBlock: t }),
      from,
      latest,
    );
    for (const l of logs) {
      const id = l.args.jobId!;
      const rec = this.store.job(id);
      if (!rec.proofUrl || keccak256(toBytes(rec.proofUrl)) !== l.args.proofHash) this.store.updateJob(id, { proofUrl: l.args.proofUrl, proofTx: l.transactionHash ?? undefined });
      await this.processJob(id);
    }
    this.store.lastScannedBlock = latest;
  }

  start() {
    const loop = async () => {
      try {
        await this.tick();
      } catch (e) {
        this.log(`watcher error: ${errMsg(e)}`);
      }
      this.timer = setTimeout(loop, config.pollMs);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
