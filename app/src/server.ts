import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";
import { formatUnits, parseUnits, isAddress, getAddress, keccak256, toBytes } from "viem";
import { config, txUrl, addrUrl, type Hex } from "./config.ts";
import { erc20Abi, escrowAbi } from "./abi.ts";
import { Signer, escrowAddress, readJob, readParams, publicClient, errMsg } from "./chain.ts";
import { parseBrief, type Brief, type Contact } from "./brief.ts";
import { hashJson } from "./canonical.ts";
import { makeProvider } from "./llm.ts";
import { Store } from "./store.ts";
import { VerifierAgent } from "./agent.ts";

const PUBLIC_DIR = resolve(import.meta.dirname, "../public");
const store = new Store();
const llm = makeProvider();
const agentSigner = config.agentPrivateKey ? new Signer(config.agentPrivateKey) : null;
const agent = new VerifierAgent(store, llm, agentSigner);
const demoClient = config.demoWallets && config.demoClientKey ? new Signer(config.demoClientKey) : null;
const demoFreelancer = config.demoWallets && config.demoFreelancerKey ? new Signer(config.demoFreelancerKey) : null;

const contactsFile = join(config.dataDir, "contacts.json");
function contacts(): Record<string, Contact> {
  const c: Record<string, Contact> = existsSync(contactsFile) ? JSON.parse(readFileSync(contactsFile, "utf8")) : {};
  if (demoFreelancer) {
    const handle = process.env.DEMO_FREELANCER_X ?? "sarah";
    if (!c["sarah"]) c["sarah"] = { address: demoFreelancer.address, handle };
    if (!c["ada"]) c["ada"] = { address: demoFreelancer.address, handle }; // alias for older example jobs
  }
  return c;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const hits = new Map<string, number[]>();
function rateLimit(req: IncomingMessage, perMin = 30) {
  const ip = req.socket.remoteAddress ?? "?";
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (arr.length > perMin) throw new HttpError(429, "Too many requests, slow down a little.");
}

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 32_000) throw new HttpError(413, "Body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

function parseJobId(s: string): bigint {
  if (!/^\d{1,12}$/.test(s)) throw new HttpError(400, "Bad job id");
  return BigInt(s);
}

function registerBrief(brief: Brief): Hex {
  const h = hashJson(brief);
  store.putBrief(h, brief);
  return h;
}

async function jobView(id: bigint) {
  const j = await readJob(id);
  if (j.status === "None") throw new HttpError(404, "Job not found");
  const rec = store.job(id);
  const refundable = await publicClient.readContract({ address: escrowAddress(), abi: escrowAbi, functionName: "refundable", args: [id] });
  return {
    jobId: id.toString(),
    status: j.status,
    client: j.client,
    payee: j.payee,
    amount: formatUnits(j.amount, config.tokenDecimals),
    deadline: Number(j.deadline),
    rejections: j.rejections,
    proofSubmittedAt: Number(j.proofSubmittedAt),
    briefHash: j.briefHash,
    proofHash: j.proofHash,
    verdictHash: j.verdictHash,
    refundable,
    brief: store.getBrief(j.briefHash),
    proofUrl: rec.proofUrl,
    createTx: rec.createTx,
    proofTx: rec.proofTx,
    agentState: rec.agentState ?? (j.status === "ProofSubmitted" ? "verifying" : "idle"),
    agentNote: rec.agentNote,
    receipts: rec.receipts,
    lastActionTx: rec.lastActionTx,
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  const m = req.method ?? "GET";
  if (m !== "GET") rateLimit(req);

  if (path === "/api/config" && m === "GET") {
    let params: any = null;
    try {
      params = config.escrowAddress ? await readParams() : null;
    } catch (e) {
      params = { error: errMsg(e) };
    }
    return json(res, 200, {
      chainId: config.chainId,
      rpcUrl: config.rpcUrl,
      explorerUrl: config.explorerUrl,
      token: config.tokenAddress,
      tokenSymbol: config.tokenSymbol,
      tokenDecimals: config.tokenDecimals,
      escrow: config.escrowAddress || null,
      agent: agentSigner?.address ?? null,
      llm: llm ? `${llm.name}:${llm.model}` : "rules-only",
      demo: demoClient && demoFreelancer ? { client: demoClient.address, freelancer: demoFreelancer.address } : null,
      params: params && !params.error ? { ...params, agentReleaseCap: formatUnits(params.agentReleaseCap, 6), maxJobAmount: formatUnits(params.maxJobAmount, 6) } : params,
    });
  }

  if (path === "/api/contacts" && m === "GET") return json(res, 200, contacts());
  if (path === "/api/contacts" && m === "POST") {
    const b = await body(req);
    const name = String(b.name ?? "").replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,30}$/.test(name) || !isAddress(String(b.address))) throw new HttpError(400, "Need a name and a valid 0x address");
    const c = existsSync(contactsFile) ? JSON.parse(readFileSync(contactsFile, "utf8")) : {};
    c[name] = { address: getAddress(b.address), handle: b.handle ? String(b.handle).replace(/^@/, "").slice(0, 30) : name };
    writeFileSync(contactsFile, JSON.stringify(c, null, 2));
    return json(res, 200, c[name]);
  }

  if (path === "/api/parse" && m === "POST") {
    const b = await body(req);
    const text = String(b.text ?? "");
    if (text.trim().length < 8) throw new HttpError(400, "Describe the job in a sentence first.");
    try {
      const r = await parseBrief(text, contacts(), llm);
      registerBrief(r.brief);
      return json(res, 200, { ...r, amountBaseUnits: parseUnits(r.brief.amount, 6).toString() });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  // Client edited the confirm card: re-validate and register the final brief.
  if (path === "/api/briefs" && m === "POST") {
    const b = await body(req);
    const brief = b.brief as Brief;
    if (!brief || brief.version !== 1 || !isAddress(brief.payee) || !(Number(brief.amount) > 0)) throw new HttpError(400, "Invalid brief");
    brief.payee = getAddress(brief.payee);
    const briefHash = registerBrief(brief);
    return json(res, 200, { briefHash, amountBaseUnits: parseUnits(brief.amount, 6).toString() });
  }

  if (path === "/api/jobs" && m === "GET") {
    if (!config.escrowAddress) return json(res, 200, []);
    const { jobCount } = await readParams();
    const ids: bigint[] = [];
    for (let i = jobCount; i > 0n && ids.length < 25; i--) ids.push(i);
    const jobs = await Promise.all(ids.map((i) => jobView(i).catch(() => null)));
    return json(res, 200, jobs.filter(Boolean));
  }

  let mm = path.match(/^\/api\/jobs\/(\d+)$/);
  if (mm && m === "GET") return json(res, 200, await jobView(parseJobId(mm[1])));

  mm = path.match(/^\/api\/jobs\/(\d+)\/receipt$/);
  if (mm && m === "GET") {
    const rec = store.job(parseJobId(mm[1]));
    const r = rec.receipts.at(-1);
    if (!r) throw new HttpError(404, "No receipt yet");
    res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="proofpay-job-${mm[1]}-receipt.json"` });
    return res.end(JSON.stringify({ ...r, explorer: r.txHash ? txUrl(r.txHash) : undefined, verify: "keccak256(canonicalJson(body)) == receiptHash == on-chain verdictHash" }, null, 2));
  }

  // Wallet-mode: browser already sent submitProof; tell the agent the URL + tx (it re-verifies against chain).
  mm = path.match(/^\/api\/jobs\/(\d+)\/(proof|verify|created)$/);
  if (mm && m === "POST") {
    const id = parseJobId(mm[1]);
    const b = await body(req);
    if (mm[2] === "created") {
      if (b.txHash) store.updateJob(id, { createTx: String(b.txHash).slice(0, 80) });
      return json(res, 200, { ok: true });
    }
    if (mm[2] === "proof" && typeof b.url === "string") {
      const j = await readJob(id);
      if (keccak256(toBytes(b.url)) !== j.proofHash) throw new HttpError(409, "That URL is not the proof recorded on-chain for this job");
      store.updateJob(id, { proofUrl: b.url, proofTx: b.txHash ? String(b.txHash).slice(0, 80) : undefined });
    }
    agent.processJob(id); // async; UI polls job status
    return json(res, 202, { ok: true });
  }

  // ------------------------------------------------------------------ demo wallets
  if (path.startsWith("/api/demo/")) {
    if (!demoClient || !demoFreelancer) throw new HttpError(404, "Demo wallets are disabled on this server");
    const b = m === "POST" ? await body(req) : {};
    const esc = escrowAddress();

    if (path === "/api/demo/balances" && m === "GET") {
      const bal = async (a: Hex) => ({
        address: a,
        tUSD8: formatUnits((await publicClient.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint, 6),
        gas: formatUnits(await publicClient.getBalance({ address: a }), 18),
      });
      return json(res, 200, { client: await bal(demoClient.address), freelancer: await bal(demoFreelancer.address), escrow: await bal(esc) });
    }

    if (path === "/api/demo/create" && m === "POST") {
      const brief = store.getBrief(String(b.briefHash ?? ""));
      if (!brief) throw new HttpError(400, "Unknown brief; parse it first");
      const amount = parseUnits(brief.amount, 6);
      const steps: { label: string; hash: string; url: string }[] = [];
      const allowance = (await publicClient.readContract({ address: config.tokenAddress, abi: erc20Abi, functionName: "allowance", args: [demoClient.address, esc] })) as bigint;
      if (allowance < amount) {
        const a = await demoClient.write({ address: config.tokenAddress, abi: erc20Abi, functionName: "approve", args: [esc, amount] });
        steps.push({ label: "Approve tUSD8", hash: a.hash, url: txUrl(a.hash) });
      }
      const sim = await publicClient.simulateContract({ address: esc, abi: escrowAbi, functionName: "createAndFund", args: [brief.payee, amount, BigInt(brief.deadline), b.briefHash], account: demoClient.account });
      const tx = await demoClient.write({ address: esc, abi: escrowAbi, functionName: "createAndFund", args: [brief.payee, amount, BigInt(brief.deadline), b.briefHash] });
      const jobId = sim.result as bigint;
      steps.push({ label: "Lock tUSD8 in escrow", hash: tx.hash, url: txUrl(tx.hash) });
      store.updateJob(jobId, { createTx: tx.hash, agentState: "idle" });
      return json(res, 200, { jobId: jobId.toString(), steps });
    }

    const id = parseJobId(String(b.jobId ?? ""));
    if (path === "/api/demo/proof" && m === "POST") {
      const url = String(b.url ?? "").trim();
      if (!url || url.length > 512) throw new HttpError(400, "Paste a public link");
      const tx = await demoFreelancer.write({ address: esc, abi: escrowAbi, functionName: "submitProof", args: [id, url] });
      store.updateJob(id, { proofUrl: url, proofTx: tx.hash, agentState: "verifying", agentNote: "Proof received on-chain. Verifying..." });
      agent.processJob(id);
      return json(res, 200, { hash: tx.hash, url: txUrl(tx.hash) });
    }
    if (path === "/api/demo/approve" && m === "POST") {
      const verdict = hashJson({ kind: "ClientApproval", jobId: id.toString(), at: Math.floor(Date.now() / 1000) });
      const tx = await demoClient.write({ address: esc, abi: escrowAbi, functionName: "approveRelease", args: [id, verdict] });
      store.updateJob(id, { agentState: "done", agentNote: "Client approved manually (human override).", lastActionTx: tx.hash });
      return json(res, 200, { hash: tx.hash, url: txUrl(tx.hash) });
    }
    if (path === "/api/demo/refund" && m === "POST") {
      const tx = await demoClient.write({ address: esc, abi: escrowAbi, functionName: "refund", args: [id] });
      store.updateJob(id, { agentState: "done", agentNote: "Refunded to client.", lastActionTx: tx.hash });
      return json(res, 200, { hash: tx.hash, url: txUrl(tx.hash) });
    }
  }
  throw new HttpError(404, "Not found");
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    const rel = normalize(url.pathname === "/" || /^\/job\/\d+$/.test(url.pathname) ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    json(res, status, { error: e instanceof HttpError ? e.message : errMsg(e) });
  }
});

if (import.meta.main ?? process.argv[1]?.endsWith("server.ts")) {
  server.listen(config.port, () => {
    console.log(`ProofPay on http://localhost:${config.port}  chain=${config.chainId} escrow=${config.escrowAddress || "(not set)"}`);
    console.log(`agent=${agentSigner?.address ?? "read-only"} llm=${llm ? llm.model : "rules-only"} demo=${!!(demoClient && demoFreelancer)}`);
    if (config.escrowAddress) agent.start();
  });
}
