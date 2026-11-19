import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContactBook,
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
  return new ContactBook(mkdtempSync(join(tmpdir(), "proofpay-contacts-")), max);
}

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

test("upsert, list, update and remove a contact", () => {
  const b = book();
  const saved = b.upsert({ name: "@DeeStar", address: SARAH.toLowerCase() }, false);
  assert.deepEqual(saved, { address: SARAH, handle: "deestar" });
  assert.equal(b.list()["deestar"].address, SARAH);

  const updated = b.upsert({ name: "deestar", address: OTHER, handle: "@clipper" }, false);
  assert.deepEqual(updated, { address: OTHER, handle: "clipper" });
  assert.equal(Object.keys(b.list()).length, 1);

  b.remove("@deestar", false);
  assert.deepEqual(b.list(), {});
  assert.throws(() => b.remove("deestar", false), (e: unknown) => e instanceof ContactError && e.status === 404);
});

test("demo mode injects sarah/ada and blocks overwrite or remove", () => {
  const b = book();
  b.upsert({ name: "deestar", address: OTHER }, false);
  // a stale file entry for sarah is ignored in demo mode
  b.upsert({ name: "sarah", address: OTHER, handle: "hacked" }, false);
  const listed = b.list({ address: SARAH, handle: "sarah" });
  assert.equal(listed.sarah.address, SARAH);
  assert.equal(listed.sarah.builtin, true);
  assert.equal(listed.ada.builtin, true);
  assert.equal(listed.ada.handle, "sarah");
  assert.equal(listed.deestar.address, OTHER);
  assert.equal(listed.deestar.builtin, undefined);

  assert.throws(() => b.upsert({ name: "sarah", address: OTHER }, true), /can't be changed/);
  assert.throws(() => b.upsert({ name: "@Ada", address: OTHER }, true), /can't be changed/);
  assert.throws(() => b.remove("sarah", true), /can't be removed/);
  assert.throws(() => b.remove("ada", true), /can't be removed/);
  // still allowed when demo mode is off
  b.remove("deestar", true);
  assert.ok(!b.list({ address: SARAH, handle: "sarah" }).deestar);
});

test("caps the number of saved people", () => {
  const b = book(2);
  b.upsert({ name: "one", address: SARAH }, false);
  b.upsert({ name: "two", address: OTHER }, false);
  assert.throws(() => b.upsert({ name: "three", address: SARAH }, false), /full \(2\)/);
  // updating an existing name does not count as a new slot
  const updated = b.upsert({ name: "one", address: OTHER }, false);
  assert.equal(updated.address, OTHER);
  assert.equal(MAX_CONTACTS, 200);
});
