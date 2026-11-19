import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbiItem,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, type Hex } from "./config.ts";
import { escrowAbi } from "./abi.ts";

export const aevum = defineChain({
  id: config.chainId,
  name: config.chainId === 44005 ? "QDay Aevum Testnet" : `Local ${config.chainId}`,
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: config.explorerUrl } },
  testnet: true,
});

export const STATUS = ["None", "Created", "Funded", "ProofSubmitted", "Released", "Refunded", "Cancelled"] as const;
export type StatusName = (typeof STATUS)[number];

export interface ChainJob {
  jobId: bigint;
  client: Hex;
  payee: Hex;
  amount: bigint;
  deadline: bigint;
  proofSubmittedAt: bigint;
  rejections: number;
  status: StatusName;
  briefHash: Hex;
  proofHash: Hex;
  verdictHash: Hex;
}

export const publicClient: PublicClient = createPublicClient({
  chain: aevum,
  transport: http(config.rpcUrl, { retryCount: 3, retryDelay: 500, timeout: 20_000 }),
}) as PublicClient;

export function escrowAddress(): Hex {
  if (!config.escrowAddress) throw new Error("ESCROW_ADDRESS is not configured");
  return config.escrowAddress;
}

export async function readJob(jobId: bigint): Promise<ChainJob> {
  const j: any = await publicClient.readContract({ address: escrowAddress(), abi: escrowAbi, functionName: "getJob", args: [jobId] });
  return { jobId, ...j, status: STATUS[Number(j.status)] };
}

export async function readParams() {
  const a = escrowAddress();
  const [agent, cap, max, count, paused] = await Promise.all([
    publicClient.readContract({ address: a, abi: escrowAbi, functionName: "agent" }),
    publicClient.readContract({ address: a, abi: escrowAbi, functionName: "agentReleaseCap" }),
    publicClient.readContract({ address: a, abi: escrowAbi, functionName: "maxJobAmount" }),
    publicClient.readContract({ address: a, abi: escrowAbi, functionName: "jobCount" }),
    publicClient.readContract({ address: a, abi: escrowAbi, functionName: "paused" }),
  ]);
  return { agent: agent as Hex, agentReleaseCap: cap as bigint, maxJobAmount: max as bigint, jobCount: count as bigint, paused: paused as boolean };
}

export const proofSubmittedEvent = parseAbiItem(
  "event ProofSubmitted(uint256 indexed jobId, address indexed payee, string proofUrl, bytes32 proofHash)",
);
export const jobCreatedEvent = parseAbiItem(
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed payee, uint256 amount, uint64 deadline, bytes32 briefHash)",
);

/** getLogs in chunks (Aevum RPC caps ranges at 1,000 blocks). */
export async function getLogsChunked<T>(fetcher: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  const out: T[] = [];
  for (let s = from; s <= to; s += config.logChunk) {
    const e = s + config.logChunk - 1n > to ? to : s + config.logChunk - 1n;
    out.push(...(await fetcher(s, e)));
  }
  return out;
}

/** Find the proof URL whose hash is currently on-chain for a job (searches back from the block it was submitted). */
export async function findProofUrl(jobId: bigint, proofHash: Hex, aroundTs: bigint): Promise<{ url: string; block: bigint } | undefined> {
  const latest = await publicClient.getBlockNumber();
  // Walk back up to ~20k blocks in chunks until found.
  for (let to = latest, steps = 0; to > 0n && steps < 25; steps++) {
    const from = to > config.logChunk ? to - config.logChunk + 1n : 0n;
    const logs = await publicClient.getLogs({ address: escrowAddress(), event: proofSubmittedEvent, args: { jobId }, fromBlock: from, toBlock: to });
    const hit = logs.reverse().find((l) => l.args.proofHash?.toLowerCase() === proofHash.toLowerCase());
    if (hit) return { url: hit.args.proofUrl!, block: hit.blockNumber! };
    const b = await publicClient.getBlock({ blockNumber: from });
    if (b.timestamp < aroundTs - 600n) break;
    to = from - 1n;
  }
  return undefined;
}

export async function jobCreatedAt(jobId: bigint, hintBlock?: bigint): Promise<number | undefined> {
  const latest = await publicClient.getBlockNumber();
  let to = hintBlock ?? latest;
  for (let steps = 0; to > 0n && steps < 40; steps++) {
    const from = to > config.logChunk ? to - config.logChunk + 1n : 0n;
    const logs = await publicClient.getLogs({ address: escrowAddress(), event: jobCreatedEvent, args: { jobId }, fromBlock: from, toBlock: to });
    if (logs.length) {
      const b = await publicClient.getBlock({ blockNumber: logs[0].blockNumber! });
      return Number(b.timestamp);
    }
    to = from - 1n;
  }
  return undefined;
}

/** Serialises transactions per signer (no nonce races) and retries transient RPC failures. */
export class Signer {
  readonly account: Account;
  readonly wallet: WalletClient;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(pk: Hex) {
    this.account = privateKeyToAccount(pk);
    this.wallet = createWalletClient({ account: this.account, chain: aevum, transport: http(config.rpcUrl, { timeout: 30_000 }) });
  }
  get address(): Hex {
    return this.account.address;
  }

  write(req: { address: Hex; abi: any; functionName: string; args: readonly unknown[] }): Promise<{ hash: Hex; blockNumber: bigint }> {
    const run = async () => {
      // Simulate first: surfaces custom errors (e.g. BadStatus) before spending gas.
      const { request } = await publicClient.simulateContract({ ...req, account: this.account } as any);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const hash = await this.wallet.writeContract({ ...(request as any), account: this.account, chain: aevum });
          const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1_500 });
          if (rcpt.status !== "success") throw Object.assign(new Error(`tx reverted: ${hash}`), { fatal: true });
          return { hash, blockNumber: rcpt.blockNumber };
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.shortMessage ?? e?.message ?? e);
          if (e?.fatal || /revert|insufficient funds|execution reverted/i.test(msg)) throw e;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      throw lastErr;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

export function errMsg(e: unknown): string {
  const anyE = e as any;
  return String(anyE?.shortMessage ?? anyE?.details ?? anyE?.message ?? e).split("\n")[0].slice(0, 300);
}
