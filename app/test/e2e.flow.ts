// Driven by scripts/local-e2e.sh against anvil. Not part of `npm test` (needs a chain).
import { test } from "node:test";
import assert from "node:assert/strict";

const APP = process.env.APP!;
const call = async (path: string, body?: unknown) => {
  const r = await fetch(APP + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
};
const waitFor = async (id: string, pred: (j: any) => boolean, ms = 20_000) => {
  const t0 = Date.now();
  for (;;) {
    const j = await call(`/api/jobs/${id}`);
    if (pred(j)) return j;
    if (Date.now() - t0 > ms) throw new Error(`timeout; last=${JSON.stringify({ s: j.status, a: j.agentState, n: j.agentNote })}`);
    await new Promise((r) => setTimeout(r, 400));
  }
};
const create = async (text: string) => {
  const p = await call("/api/parse", { text });
  const c = await call("/api/demo/create", { briefHash: p.briefHash });
  return c.jobId as string;
};
const BRIEF = 'Pay @sarah 5 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by tomorrow';

test("happy path: proof accepted -> agent pays freelancer on-chain", async () => {
  const before = await call("/api/demo/balances");
  const id = await create(BRIEF);
  assert.equal((await call(`/api/jobs/${id}`)).status, "Funded");
  await call("/api/demo/proof", { jobId: id, url: "fixture://good" });
  const j = await waitFor(id, (j) => j.status === "Released");
  const r = j.receipts.at(-1);
  assert.equal(r.body.decision, "release");
  assert.equal(r.action, "agentRelease");
  assert.equal(j.verdictHash, r.receiptHash); // receipt anchored on-chain
  const after = await call("/api/demo/balances");
  assert.equal(Number(after.freelancer.tUSD8) - Number(before.freelancer.tUSD8), 5);
  // idempotent: re-trigger does nothing
  await call(`/api/jobs/${id}/verify`, {});
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await call(`/api/jobs/${id}`)).receipts.length, 1);
});

test("bad proof: agent rejects, client refunds", async () => {
  const before = await call("/api/demo/balances");
  const id = await create(BRIEF);
  await call("/api/demo/proof", { jobId: id, url: "fixture://bad" });
  const j = await waitFor(id, (j) => j.status === "Funded" && j.rejections === 1 && j.receipts.length > 0);
  assert.equal(j.receipts.at(-1).body.decision, "reject");
  assert.ok(j.refundable);
  await call("/api/demo/refund", { jobId: id });
  const after = await call("/api/demo/balances");
  assert.equal((await call(`/api/jobs/${id}`)).status, "Refunded");
  assert.equal(Number(after.client.tUSD8), Number(before.client.tUSD8));
});

test("impostor author is rejected by hard rules", async () => {
  const id = await create(BRIEF);
  await call("/api/demo/proof", { jobId: id, url: "fixture://impostor" });
  const j = await waitFor(id, (j) => j.rejections === 1 && j.receipts.length > 0);
  assert.ok(j.receipts.at(-1).body.checks.some((c: any) => c.id === "author" && !c.pass));
});

test("prompt injection: no auto-pay, client approves manually", async () => {
  const id = await create(BRIEF);
  await call("/api/demo/proof", { jobId: id, url: "fixture://inject" });
  const j = await waitFor(id, (j) => j.agentState === "needs_human");
  assert.equal(j.status, "ProofSubmitted");
  assert.ok(j.receipts.at(-1).body.injectionFlags.includes("ignore-previous-instructions"));
  await call("/api/demo/approve", { jobId: id });
  assert.equal((await call(`/api/jobs/${id}`)).status, "Released");
});

test("above agent cap: needs human even with perfect proof", async () => {
  const id = await create(BRIEF.replace("5 tUSD8", "150 tUSD8"));
  await call("/api/demo/proof", { jobId: id, url: "fixture://good" });
  const j = await waitFor(id, (j) => j.agentState === "needs_human");
  assert.match(j.receipts.at(-1).body.reasoning, /auto-pay cap/);
  assert.equal(j.status, "ProofSubmitted");
});
