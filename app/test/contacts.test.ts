import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Contacts,
  FileContacts,
  DEMO_OWNER,
  sanitizeOwner,
  ContactError,
  MAX_CONTACTS,
  sanitizeAddress,
  sanitizeHandle,
  sanitizeName,
  unknownPayeeMessage,
} from "../src/contacts.ts";
import { parseRules } from "../src/brief.ts";

const SARAH = "0xd188C43a8B200ef35D10992AfAD22dC0fb8a387f" as const;
const OTHER = "0x0000000000000000000000000000000000000001" as const;
const now = new Date("2026-11-19T08:00:00Z");

function book(max?: number) {
  return new Contacts(new FileContacts(mkdtempSync(join(tmpdir(), "proofpay-contacts-"))), max);
}
const D = DEMO_OWNER;
const ME = "0x00000000000000000000000000000000000000aa";
const YOU = "0x00000000000000000000000000000000000000bb";

test("sanitizes name and handle (lowercase, strip @, reject junk)", () => {
  assert.equal(sanitizeName("@DeeStar"), "deestar");
  assert.equal(sanitizeHandle("", "deestar"), "deestar");
  assert.equal(sanitizeHandle("@Ada_1", "deestar"), "ada_1");
  assert.throws(() => sanitizeName("Sarah Ann"), ContactError);
  assert.throws(() => sanitizeName(""), ContactError);
  assert.throws(() => sanitizeName("x".repeat(31)), ContactError);
  assert.throws(() => sanitizeHandle("bad handle", "x"), ContactError);
});

test("checksums a valid address and rejects a bad one", () => {
  assert.equal(sanitizeAddress(SARAH.toLowerCase()), SARAH);
  assert.throws(() => sanitizeAddress("0x1234"), ContactError);
  assert.throws(() => sanitizeAddress("not-an-address"), ContactError);
  // well-known EIP-55 address with the last character's case flipped
  assert.throws(() => sanitizeAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAED"), ContactError);
});

test("unknown payee message points at Saved people", () => {
  assert.match(unknownPayeeMessage("DeeStar"), /Save @deestar in Saved people first/);
  assert.match(unknownPayeeMessage(), /Save them in Saved people first/);
});

test("parseRules uses a saved contact and names the missing one", () => {
  const r = parseRules("pay @deestar 0.5 tUSD8 for a post mentioning $DCTY", { deestar: { address: SARAH, handle: "deestar" } }, now);
  assert.equal(r.brief.payee, SARAH);
  assert.equal(r.brief.payeeHandle, "deestar");
  assert.equal(r.brief.amount, "0.5");
  assert.throws(() => parseRules("pay @deestar 0.5 tUSD8 for a post mentioning $DCTY", {}, now), /Save @deestar in Saved people first/);
});

test("upsert, list, update and remove a contact", async () => {
  const b = book();
  const saved = await b.upsert(D, { name: "@DeeStar", address: SARAH.toLowerCase() }, false);
  assert.deepEqual(saved, { address: SARAH, handle: "deestar" });
  assert.equal((await b.list(D))["deestar"].address, SARAH);

  const updated = await b.upsert(D, { name: "deestar", address: OTHER, handle: "@clipper" }, false);
  assert.deepEqual(updated, { address: OTHER, handle: "clipper" });
  assert.equal(Object.keys(await b.list(D)).length, 1);

  await b.remove(D, "@deestar", false);
  assert.deepEqual(await b.list(D), {});
  await assert.rejects(() => b.remove(D, "deestar", false), (e: unknown) => e instanceof ContactError && e.status === 404);
});

test("demo mode injects sarah/ada and blocks overwrite or remove", async () => {
  const b = book();
  await b.upsert(D, { name: "deestar", address: OTHER }, false);
  // a stale file entry for sarah is ignored in demo mode
  await b.upsert(D, { name: "sarah", address: OTHER, handle: "hacked" }, false);
  const listed = await b.list(D, { address: SARAH, handle: "sarah" });
  assert.equal(listed.sarah.address, SARAH);
  assert.equal(listed.sarah.builtin, true);
  assert.equal(listed.ada.builtin, true);
  assert.equal(listed.ada.handle, "sarah");
  assert.equal(listed.deestar.address, OTHER);
  assert.equal(listed.deestar.builtin, undefined);

  await assert.rejects(() => b.upsert(D, { name: "sarah", address: OTHER }, true), /can't be changed/);
  await assert.rejects(() => b.upsert(D, { name: "@Ada", address: OTHER }, true), /can't be changed/);
  await assert.rejects(() => b.remove(D, "sarah", true), /can't be removed/);
  await assert.rejects(() => b.remove(D, "ada", true), /can't be removed/);
  // still allowed when demo mode is off
  await b.remove(D, "deestar", true);
  assert.ok(!(await b.list(D, { address: SARAH, handle: "sarah" })).deestar);
});

test("caps the number of saved people per owner", async () => {
  const b = book(2);
  await b.upsert(ME, { name: "one", address: SARAH }, false);
  await b.upsert(ME, { name: "two", address: OTHER }, false);
  await assert.rejects(() => b.upsert(ME, { name: "three", address: SARAH }, false), /full \(2\)/);
  // updating an existing name does not count as a new slot
  const updated = await b.upsert(ME, { name: "one", address: OTHER }, false);
  assert.equal(updated.address, OTHER);
  // another owner has their own quota
  await b.upsert(YOU, { name: "three", address: SARAH }, false);
  assert.equal(MAX_CONTACTS, 200);
});

test("each wallet has its own private list; demo names aren't injected there", async () => {
  const b = book();
  await b.upsert(ME, { name: "deestar", address: SARAH }, true);
  await b.upsert(YOU, { name: "deestar", address: OTHER }, true);
  assert.equal((await b.list(ME, { address: SARAH, handle: "sarah" })).deestar.address, SARAH);
  assert.equal((await b.list(YOU)).deestar.address, OTHER);
  assert.equal((await b.list(ME, { address: SARAH, handle: "sarah" })).sarah, undefined);
  assert.deepEqual(await b.list(D), {});
  // "sarah" is a normal name for a wallet owner
  await b.upsert(ME, { name: "sarah", address: OTHER }, true);
  await b.remove(ME, "sarah", true);
  await assert.rejects(() => b.upsert(ME, { name: "me", address: ME }, false), /your own wallet/);
});

test("owner must be demo or a wallet address", () => {
  assert.equal(sanitizeOwner("DEMO"), "demo");
  assert.equal(sanitizeOwner(ME.toUpperCase().replace("0X", "0x")), ME);
  assert.throws(() => sanitizeOwner("0x123"), ContactError);
  assert.throws(() => sanitizeOwner("../etc"), ContactError);
});
