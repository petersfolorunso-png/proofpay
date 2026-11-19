import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";
import type { Contact } from "./brief.ts";

export const MAX_CONTACTS = 200;
export const NAME_RE = /^[a-z0-9_]{1,30}$/;
export const PROTECTED_DEMO_NAMES = ["sarah", "ada"] as const;

export type SavedContact = Contact & { builtin?: boolean };

export class ContactError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export function normalizeName(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

export function sanitizeName(raw: unknown): string {
  const name = normalizeName(raw);
  if (!NAME_RE.test(name)) throw new ContactError(400, "Use a name like deestar (letters, numbers or _, up to 30 characters).");
  return name;
}

export function sanitizeHandle(raw: unknown, fallback: string): string {
  const h = normalizeName(raw);
  if (!h) return fallback;
  if (!NAME_RE.test(h)) throw new ContactError(400, "Use an X handle like deestar (letters, numbers or _, up to 30 characters).");
  return h;
}

export function sanitizeAddress(raw: unknown): `0x${string}` {
  const a = String(raw ?? "").trim();
  if (!isAddress(a)) {
    if (isAddress(a, { strict: false })) {
      throw new ContactError(400, "That address has a typo (bad checksum). Please paste it again.");
    }
    throw new ContactError(400, "That doesn't look like a wallet address. It should start with 0x and be 42 characters.");
  }
  return getAddress(a);
}

export function unknownPayeeMessage(handle?: string): string {
  if (handle) return `Who should get paid? Save @${handle.toLowerCase()} in Saved people first, or paste a 0x address.`;
  return "Who should get paid? Save them in Saved people first, or paste a 0x address.";
}

function isProtected(owner: string, name: string, demoMode: boolean): boolean {
  return owner === DEMO_OWNER && demoMode && (PROTECTED_DEMO_NAMES as readonly string[]).includes(name);
}

/** "demo" (the shared demo list) or a lowercase 0x wallet address. */
export const DEMO_OWNER = "demo";
export function sanitizeOwner(raw: unknown): string {
  const o = String(raw ?? "").trim().toLowerCase();
  if (o === DEMO_OWNER || /^0x[0-9a-f]{40}$/.test(o)) return o;
  throw new ContactError(400, "Unknown owner for Saved people.");
}

/** Where saved people are kept. Owner is "demo" or a lowercase wallet address; name is already sanitized. */
export interface ContactBackend {
  readonly kind: string;
  list(owner: string): Promise<Record<string, Contact>>;
  /** Insert or update. Must throw ContactError(400, "...full...") when a NEW name would exceed `max`. */
  put(owner: string, name: string, c: { address: `0x${string}`; handle: string }, max: number): Promise<void>;
  /** Returns false when the name wasn't there. */
  del(owner: string, name: string): Promise<boolean>;
}

/** Local JSON file backend (dev / fallback). Not durable on free hosts. */
export class FileContacts implements ContactBackend {
  readonly kind = "file";
  private file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "contacts-by-owner.json");
    // One-time import of the old shared list (contacts.json) as the demo list.
    const legacy = join(dir, "contacts.json");
    if (!existsSync(this.file) && existsSync(legacy)) {
      try {
        const old = JSON.parse(readFileSync(legacy, "utf8"));
        if (old && typeof old === "object" && !Array.isArray(old)) this.write({ [DEMO_OWNER]: old });
      } catch {
        /* ignore a corrupt legacy file */
      }
    }
  }
  private read(): Record<string, Record<string, Contact>> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }
  private write(all: Record<string, Record<string, Contact>>) {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.file);
  }
  async list(owner: string) {
    return { ...(this.read()[owner] ?? {}) };
  }
  async put(owner: string, name: string, c: { address: `0x${string}`; handle: string }, max: number) {
    const all = this.read();
    const mine = (all[owner] ??= {});
    if (!mine[name] && Object.keys(mine).length >= max) throw new ContactError(400, `Saved people is full (${max}). Remove someone first.`);
    mine[name] = c;
    this.write(all);
  }
  async del(owner: string, name: string) {
    const all = this.read();
    if (!all[owner]?.[name]) return false;
    delete all[owner][name];
    this.write(all);
    return true;
  }
}

/**
 * Saved people, one list per owner. The demo list (owner "demo") gets sarah/ada injected at read time,
 * and in demo mode those names can't be overwritten or removed. Wallet owners must be authenticated by
 * the caller (signed sign-in message) before upsert/remove.
 */
export class Contacts {
  readonly backend: ContactBackend;
  private max: number;
  constructor(backend: ContactBackend, max = MAX_CONTACTS) {
    this.backend = backend;
    this.max = max;
  }

  async list(owner: string, demo?: { address: `0x${string}`; handle: string } | null): Promise<Record<string, SavedContact>> {
    const o = sanitizeOwner(owner);
    const c: Record<string, SavedContact> = { ...(await this.backend.list(o)) };
    if (demo && o === DEMO_OWNER) {
      for (const name of PROTECTED_DEMO_NAMES) c[name] = { address: demo.address, handle: demo.handle, builtin: true };
    }
    return c;
  }

  async upsert(owner: string, input: { name?: unknown; address?: unknown; handle?: unknown }, demoMode: boolean): Promise<SavedContact> {
    const o = sanitizeOwner(owner);
    const name = sanitizeName(input.name);
    if (isProtected(o, name, demoMode)) throw new ContactError(400, `@${name} is a built-in demo contact and can't be changed.`);
    const address = sanitizeAddress(input.address);
    const handle = sanitizeHandle(input.handle, name);
    if (o !== DEMO_OWNER && address.toLowerCase() === o) throw new ContactError(400, "That's your own wallet. Save the person you want to pay.");
    await this.backend.put(o, name, { address, handle }, this.max);
    return { address, handle };
  }

  async remove(owner: string, rawName: unknown, demoMode: boolean): Promise<void> {
    const o = sanitizeOwner(owner);
    const name = sanitizeName(rawName);
    if (isProtected(o, name, demoMode)) throw new ContactError(400, `@${name} is a built-in demo contact and can't be removed.`);
    if (!(await this.backend.del(o, name))) throw new ContactError(404, `@${name} isn't in Saved people.`);
  }
}
