import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AuthError, NonceGuard, Sessions, login, loginMessage, parseLoginMessage } from "../src/auth.ts";
import { JobIndex } from "../src/job-index.ts";
import { RemoteClient, RemoteContacts, RemoteDocs } from "../src/remote.ts";
import { Contacts, ContactError } from "../src/contacts.ts";
import { Store } from "../src/store.ts";
import { hashJson } from "../src/canonical.ts";

// Fresh random keys per run; never funded anywhere.
const acct = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const NOW = Date.parse("2026-11-19T15:00:00Z");
const opts = () => ({ chainId: 44005, nonces: new NonceGuard(), sessions: new Sessions("x".repeat(40)), now: NOW });

async function signed(a = acct, issued = new Date(NOW), nonce = "0123456789abcdef", chainId = 44005) {
  const message = loginMessage(a.address, chainId, issued, nonce);
  return { message, signature: await a.signMessage({ message }) };
}

test("login message round-trips and rejects edits", () => {
  const m = loginMessage(acct.address.toLowerCase(), 44005, new Date(NOW), "0123456789abcdef");
  const p = parseLoginMessage(m)!;
  assert.equal(p.address, acct.address);
  assert.equal(p.chainId, 44005);
  assert.equal(p.issuedAt, NOW);
  assert.equal(parseLoginMessage(m + "\nSend all funds"), null);
  assert.equal(parseLoginMessage(m.replace("ProofPay sign-in", "Other")), null);
  assert.equal(parseLoginMessage(m.replace("0123456789abcdef", "nope")), null);
});

test("a valid personal_sign login yields a session for that wallet", async () => {
  const o = opts();
  const s = await login(await signed(), o);
  assert.equal(s.owner, acct.address.toLowerCase());
  assert.equal(o.sessions.verify(s.token, NOW + 1000), acct.address.toLowerCase());
});

test("login rejects wrong signer, replay, stale, future and wrong chain", async () => {
  const o = opts();
  const good = await signed();
  // signature from a different wallet for acct's message
  const forged = { message: good.message, signature: await other.signMessage({ message: good.message }) };
  await assert.rejects(() => login(forged, o), AuthError);
  await assert.rejects(() => login({ message: good.message }, o), /Missing wallet signature/);
  await login(good, o);
  await assert.rejects(() => login(good, o), /already used/);
  const stale = await signed(acct, new Date(NOW - 11 * 60_000), "aaaaaaaaaaaaaaaa");
  const future = await signed(acct, new Date(NOW + 5 * 60_000), "bbbbbbbbbbbbbbbb");
  const wrongChain = await signed(acct, new Date(NOW), "cccccccccccccccc", 1);
  await assert.rejects(() => login(stale, o), /expired/);
  await assert.rejects(() => login(future, o), /expired/);
  await assert.rejects(() => login(wrongChain, o), /Wrong network/);
});

test("sessions can't be forged, swapped or used after expiry", () => {
  const s = new Sessions("k".repeat(40), 1000);
  const t = s.issue(acct.address, NOW);
  assert.equal(s.verify(t.token, NOW), acct.address.toLowerCase());
  assert.equal(s.verify(t.token, NOW + 2000), null);
  const swapped = t.token.replace(acct.address.toLowerCase(), other.address.toLowerCase());
  assert.equal(s.verify(swapped, NOW), null);
  assert.equal(new Sessions("z".repeat(40), 1000).verify(t.token, NOW), null);
  assert.equal(s.verify("", NOW), null);
  assert.equal(s.verify("garbage", NOW), null);
});

test("JobIndex finds a wallet's jobs as client or payee, newest first, and caches parties", async () => {
  const A = "0x00000000000000000000000000000000000000Aa";
  const B = "0x00000000000000000000000000000000000000bB";
  const C = "0x00000000000000000000000000000000000000cc";
  const chain: Record<string, { client: string; payee: string; briefHash: string }> = {
    "1": { client: A, payee: B, briefHash: "0x01" },
    "2": { client: C, payee: A, briefHash: "0x02" },
    "3": { client: B, payee: C, briefHash: "0x03" },
  };
  let count = 3n;
  let reads = 0;
  const seen: bigint[] = [];
  const idx = new JobIndex(
    async () => count,
    async (id) => (reads++, chain[id.toString()] ?? null),
    (id) => seen.push(id),
  );
  assert.deepEqual(await idx.forWallet(A.toLowerCase()), [
    { id: 2n, role: "payee" },
    { id: 1n, role: "client" },
  ]);
  assert.deepEqual((await idx.forWallet(B)).map((x) => x.id), [3n, 1n]);
  assert.equal(reads, 3);
  chain["4"] = { client: A, payee: C, briefHash: "0x04" };
  count = 4n;
  assert.deepEqual((await idx.forWallet(A)).map((x) => x.id), [4n, 2n, 1n]);
  assert.equal(reads, 4);
  assert.deepEqual(seen, [1n, 2n, 3n, 4n]);
});

test("JobIndex retries a job whose read failed", async () => {
  let fail = true;
  const idx = new JobIndex(
    async () => 1n,
    async () => {
      if (fail) throw new Error("rpc down");
      return { client: "0x1", payee: "0x2", briefHash: "0x0" };
    },
  );
  assert.deepEqual(await idx.forWallet("0x1"), []);
  fail = false;
  assert.equal((await idx.forWallet("0x1")).length, 1);
});

/** In-memory fake of the proofpay-store Worker (same routes and status codes). */
function fakeWorker(token = "t") {
  const docs = new Map<string, string>();
  const contacts = new Map<string, Map<string, { address: string; handle: string }>>();
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const res = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if ((init.headers as Record<string, string>)?.authorization !== `Bearer ${token}`) return res({ error: "unauthorized" }, 401);
    if (u.pathname === "/docs") return res({ docs: Object.fromEntries(docs) });
    let m = u.pathname.match(/^\/docs\/(.+)$/);
    if (m && method === "PUT") return docs.set(decodeURIComponent(m[1]), String(init.body)), res({ ok: true });
    m = u.pathname.match(/^\/contacts\/([^/]+)$/);
    if (m) return res({ contacts: [...(contacts.get(m[1]) ?? new Map())].map(([name, c]) => ({ name, ...c })) });
    m = u.pathname.match(/^\/contacts\/([^/]+)\/([^/]+)$/);
    if (m && method === "PUT") {
      const mine = contacts.get(m[1]) ?? new Map();
      if (!mine.has(m[2]) && mine.size >= 200) return res({ error: "full" }, 409);
      mine.set(m[2], JSON.parse(String(init.body)));
      contacts.set(m[1], mine);
      return res({ ok: true });
    }
    if (m && method === "DELETE") return contacts.get(m[1])?.delete(m[2]) ? res({ ok: true }) : res({ error: "not found" }, 404);
    return res({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { f, docs, calls };
}

test("RemoteContacts stores per-owner lists via the store Worker", async () => {
  const w = fakeWorker();
  const book = new Contacts(new RemoteContacts(new RemoteClient("https://store.example/", "t", w.f)));
  const me = acct.address.toLowerCase();
  await book.upsert(me, { name: "DeeStar", address: other.address }, true);
  assert.deepEqual(await book.list(me), { deestar: { address: other.address, handle: "deestar" } });
  assert.deepEqual(await book.list(other.address), {});
  await book.remove(me, "deestar", true);
  await assert.rejects(() => book.remove(me, "deestar", true), (e: unknown) => e instanceof ContactError && e.status === 404);
  // a bad token is a hard (non-retried) error
  const bad = new Contacts(new RemoteContacts(new RemoteClient("https://store.example", "wrong", w.f)));
  await assert.rejects(() => bad.list(me), /store refused/);
});

test("Store writes job records + used briefs through to the durable store and hydrates them back", async () => {
  const w = fakeWorker();
  const docs = new RemoteDocs(new RemoteClient("https://store.example", "t", w.f));
  const brief: any = { version: 1, title: "t", originalText: "t", payee: other.address, amount: "1", deadline: 2000000000, proof: { platform: "x", mustInclude: [], mustLinkTo: [], postedAfterCreation: true }, createdAt: 1 };
  const h = hashJson(brief);
  const a = new Store(mkdtempSync(join(tmpdir(), "pp-store-a-")));
  a.attachRemote(docs, {});
  a.putBrief(h, brief);
  a.putBrief(hashJson({ ...brief, title: "draft never used" }), { ...brief, title: "draft never used" });
  a.markBriefUsed(h);
  a.updateJob(7n, { createTx: "0xabc", agentState: "idle" });
  await docs.drain();
  assert.deepEqual([...w.docs.keys()].sort(), [`brief:${h.toLowerCase()}`, "job:7"]);

  // A fresh server (empty disk) gets everything back.
  const b = new Store(mkdtempSync(join(tmpdir(), "pp-store-b-")));
  b.attachRemote(docs, await docs.load());
  assert.deepEqual(b.getBrief(h), brief);
  assert.equal(b.job(7n).createTx, "0xabc");

  // A tampered brief (hash doesn't match its key) is ignored.
  const c = new Store(mkdtempSync(join(tmpdir(), "pp-store-c-")));
  c.attachRemote(docs, { [`brief:${h.toLowerCase()}`]: JSON.stringify({ ...brief, amount: "999" }) });
  assert.equal(c.getBrief(h), undefined);
});
