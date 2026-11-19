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

function isProtected(name: string, demoMode: boolean): boolean {
  return demoMode && (PROTECTED_DEMO_NAMES as readonly string[]).includes(name);
}

/** File-backed address book. Demo names (sarah, ada) are injected at read time and cannot be overwritten in demo mode. */
export class ContactBook {
  private file: string;
  private max: number;
  constructor(dir: string, max = MAX_CONTACTS) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "contacts.json");
    this.max = max;
  }

  private readFile(): Record<string, Contact> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return raw as Record<string, Contact>;
    } catch {
      return {};
    }
  }

  private writeFile(c: Record<string, Contact>) {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(c, null, 2));
    renameSync(tmp, this.file);
  }

  list(demo?: { address: `0x${string}`; handle: string } | null): Record<string, SavedContact> {
    const c: Record<string, SavedContact> = { ...this.readFile() };
    if (demo) {
      for (const name of PROTECTED_DEMO_NAMES) {
        c[name] = { address: demo.address, handle: demo.handle, builtin: true };
      }
    }
    return c;
  }

  upsert(input: { name?: unknown; address?: unknown; handle?: unknown }, demoMode: boolean): SavedContact {
    const name = sanitizeName(input.name);
    if (isProtected(name, demoMode)) throw new ContactError(400, `@${name} is a built-in demo contact and can't be changed.`);
    const address = sanitizeAddress(input.address);
    const handle = sanitizeHandle(input.handle, name);
    const c = this.readFile();
    if (!c[name] && Object.keys(c).length >= this.max) {
      throw new ContactError(400, `Saved people is full (${this.max}). Remove someone first.`);
    }
    c[name] = { address, handle };
    this.writeFile(c);
    return c[name];
  }

  remove(rawName: unknown, demoMode: boolean): void {
    const name = sanitizeName(rawName);
    if (isProtected(name, demoMode)) throw new ContactError(400, `@${name} is a built-in demo contact and can't be removed.`);
    const c = this.readFile();
    if (!c[name]) throw new ContactError(404, `@${name} isn't in Saved people.`);
    delete c[name];
    this.writeFile(c);
  }
}
