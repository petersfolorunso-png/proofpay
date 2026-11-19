#!/usr/bin/env node
// Real Aevum testnet e2e: 1 tUSD8 release path + 1 tUSD8 reject+refund.
// Uses demo wallets and fixture proofs. Never prints keys.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const APP = process.env.APP || "http://127.0.0.1:8787";
const FIX = process.env.PROOF_FIXTURES_DIR || resolve("app/fixtures-testnet");
const OUT = process.env.E2E_OUT || resolve("deployments/testnet-e2e.json");
const EXPLORER = "https://explorer-test.qday.info";
mkdirSync(FIX, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(APP + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`${path}: ${j.error || r.status}`);
      return j;
    } catch (e) {
      last = e;
      console.error(`retry ${i + 1} ${path}: ${e.message}`);
      await sleep(2000 + i * 1000);
    }
  }
  throw last;
}

async function waitFor(id, pred, ms = 180_000, label = "job") {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await call(`/api/jobs/${id}`, undefined, 3);
      if (pred(last)) return last;
      const age = Date.now() - t0;
      if (age > ms) throw new Error(`timeout waiting for ${label}; last=${JSON.stringify({ s: last.status, a: last.agentState, n: last.agentNote, r: last.rejections })}`);
      if (age % 15000 < 2500) console.log(`  ... ${label} ${id}: status=${last.status} agent=${last.agentState} note=${last.agentNote || ""}`);
    } catch (e) {
      if (Date.now() - t0 > ms) throw e;
      console.error(`  poll error: ${e.message}`);
    }
    await sleep(2500);
  }
}

function writeFixture(name, body) {
  writeFileSync(resolve(FIX, name + ".json"), JSON.stringify(body, null, 2));
}

const report = {
  chainId: 44005,
  explorer: EXPLORER,
  escrow: null,
  startedAt: new Date().toISOString(),
  jobs: [],
  balances: {},
};

try {
  const cfg = await call("/api/config");
  console.log("config", { chainId: cfg.chainId, escrow: cfg.escrow, llm: cfg.llm, demo: cfg.demo, agent: cfg.agent });
  if (cfg.chainId !== 44005) throw new Error("not Aevum");
  if (!cfg.escrow || !cfg.demo) throw new Error("escrow or demo wallets missing");
  report.escrow = cfg.escrow;
  report.token = cfg.token;
  report.agent = cfg.agent;
  report.demo = cfg.demo;

  const before = await call("/api/demo/balances");
  report.balances.before = before;
  console.log("balances before", JSON.stringify(before, null, 2));

  const BRIEF_OK = 'Pay @sarah 1 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by Friday';
  const BRIEF_BAD = 'Pay @sarah 1 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by next week';

  // ----- release path -----
  console.log("\n=== RELEASE PATH ===");
  const parsed = await call("/api/parse", { text: BRIEF_OK });
  console.log("parsed brief", { payee: parsed.brief?.payee, amount: parsed.brief?.amount, deadline: parsed.brief?.deadline, mustInclude: parsed.brief?.proof?.mustInclude, author: parsed.brief?.proof?.authorHandle, hash: parsed.briefHash });
  if (parsed.brief.amount !== "1") throw new Error("expected 1 tUSD8, got " + parsed.brief.amount);
  const created = await call("/api/demo/create", { briefHash: parsed.briefHash });
  const id1 = created.jobId;
  console.log("created job", id1, created.steps);
  const funded = await waitFor(id1, (j) => j.status === "Funded", 60_000, "funded");
  const createdAt = funded.proofSubmittedAt || Math.floor(Date.now() / 1000); // job has no createdAt field exported?
  // Use wall clock after create: posted "now", will submit in a couple seconds
  const postedAt = Math.floor(Date.now() / 1000) - 2;
  writeFixture("good", {
    author: parsed.brief.proof.authorHandle || "sarah",
    createdAt: postedAt,
    text: 'ProofPay is live on #Aevum — pay on proof, not on promises.',
  });
  await sleep(1500);
  const proof1 = await call("/api/demo/proof", { jobId: id1, url: "fixture://good" });
  console.log("submitted good proof", proof1);
  const released = await waitFor(id1, (j) => j.status === "Released", 180_000, "released");
  const rec1 = released.receipts.at(-1);
  console.log("RELEASED", { jobId: id1, decision: rec1?.body?.decision, action: rec1?.action, verdictHash: released.verdictHash, receiptHash: rec1?.receiptHash, tx: rec1?.txHash, reasoning: rec1?.body?.reasoning });
  if (rec1?.body?.decision !== "release") throw new Error("expected release");
  if (released.verdictHash !== rec1.receiptHash) throw new Error("receipt hash mismatch");

  report.jobs.push({
    path: "release",
    jobId: id1,
    brief: BRIEF_OK,
    briefHash: parsed.briefHash,
    status: released.status,
    createSteps: created.steps,
    proofTx: proof1.hash || released.proofTx,
    proofTxUrl: proof1.url || (released.proofTx ? `${EXPLORER}/tx/${released.proofTx}` : null),
    createTx: released.createTx,
    createTxUrl: released.createTx ? `${EXPLORER}/tx/${released.createTx}` : created.steps?.find((s) => s.label.includes("Lock"))?.url,
    releaseTx: rec1.txHash || released.lastActionTx,
    releaseTxUrl: (rec1.txHash || released.lastActionTx) ? `${EXPLORER}/tx/${rec1.txHash || released.lastActionTx}` : null,
    verdictHash: released.verdictHash,
    receiptHash: rec1.receiptHash,
    decision: rec1.body.decision,
    reasoning: rec1.body.reasoning,
    checks: rec1.body.checks,
    receipt: rec1,
  });

  // ----- reject + refund path -----
  console.log("\n=== REJECT + REFUND PATH ===");
  const parsed2 = await call("/api/parse", { text: BRIEF_BAD });
  const created2 = await call("/api/demo/create", { briefHash: parsed2.briefHash });
  const id2 = created2.jobId;
  console.log("created job", id2, created2.steps);
  await waitFor(id2, (j) => j.status === "Funded", 60_000, "funded");
  writeFixture("bad", {
    author: parsed2.brief.proof.authorHandle || "sarah",
    createdAt: Math.floor(Date.now() / 1000) - 2,
    text: "Working on something cool, more soon.",
  });
  await sleep(1500);
  const proof2 = await call("/api/demo/proof", { jobId: id2, url: "fixture://bad" });
  console.log("submitted bad proof", proof2);
  const rejected = await waitFor(id2, (j) => j.status === "Funded" && Number(j.rejections) === 1 && j.receipts?.length > 0, 180_000, "rejected");
  const rec2 = rejected.receipts.at(-1);
  console.log("REJECTED", { jobId: id2, decision: rec2?.body?.decision, refundable: rejected.refundable, reasoning: rec2?.body?.reasoning, tx: rec2?.txHash });
  if (rec2?.body?.decision !== "reject") throw new Error("expected reject");
  if (!rejected.refundable) throw new Error("expected refundable after reject");
  const refund = await call("/api/demo/refund", { jobId: id2 });
  console.log("refund tx", refund);
  const refunded = await waitFor(id2, (j) => j.status === "Refunded", 90_000, "refunded");

  report.jobs.push({
    path: "reject_refund",
    jobId: id2,
    brief: BRIEF_BAD,
    briefHash: parsed2.briefHash,
    status: refunded.status,
    createSteps: created2.steps,
    proofTx: proof2.hash || rejected.proofTx,
    proofTxUrl: proof2.url || (rejected.proofTx ? `${EXPLORER}/tx/${rejected.proofTx}` : null),
    createTx: rejected.createTx,
    createTxUrl: rejected.createTx ? `${EXPLORER}/tx/${rejected.createTx}` : created2.steps?.find((s) => s.label.includes("Lock"))?.url,
    rejectTx: rec2.txHash,
    rejectTxUrl: rec2.txHash ? `${EXPLORER}/tx/${rec2.txHash}` : null,
    refundTx: refund.hash || refunded.lastActionTx,
    refundTxUrl: (refund.url) || ((refund.hash || refunded.lastActionTx) ? `${EXPLORER}/tx/${refund.hash || refunded.lastActionTx}` : null),
    verdictHash: rejected.verdictHash,
    receiptHash: rec2.receiptHash,
    decision: rec2.body.decision,
    reasoning: rec2.body.reasoning,
    checks: rec2.body.checks,
    receipt: rec2,
  });

  const after = await call("/api/demo/balances");
  report.balances.after = after;
  const fDelta = Number(after.freelancer.tUSD8) - Number(before.freelancer.tUSD8);
  const cDelta = Number(after.client.tUSD8) - Number(before.client.tUSD8);
  console.log("balances after", JSON.stringify(after, null, 2));
  console.log(`freelancer tUSD8 delta=${fDelta} (expect 1), client delta=${cDelta} (expect -1)`);
  if (Math.abs(fDelta - 1) > 0.0001) throw new Error("freelancer should have gained 1 tUSD8");
  if (Math.abs(cDelta - -1) > 0.0001) throw new Error("client should have net -1 tUSD8");

  report.ok = true;
  report.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log("\nWROTE", OUT);
  console.log("SUCCESS");
} catch (e) {
  report.ok = false;
  report.error = e.message;
  report.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.error("FAILED", e);
  process.exit(1);
}
