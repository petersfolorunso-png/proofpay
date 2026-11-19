/**
 * Wallet sign-in for per-user data (Saved people). The browser asks the wallet to personal_sign a
 * plain-text message; the server checks the signature, the time window and a single-use nonce, then
 * issues a short HMAC session token bound to that wallet. No transaction, no gas.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";

export const LOGIN_TITLE = "ProofPay sign-in";
export const LOGIN_MAX_AGE_MS = 10 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 3600_000;

export class AuthError extends Error {
  status = 401;
}

export function loginMessage(address: string, chainId: number, issuedAt: Date, nonce: string): string {
  return [
    LOGIN_TITLE,
    "",
    "Sign this to manage your Saved people on ProofPay. It's free: no transaction, no gas.",
    "",
    `Wallet: ${getAddress(address)}`,
    `Chain ID: ${chainId}`,
    `Issued at: ${issuedAt.toISOString()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export function parseLoginMessage(msg: string): { address: `0x${string}`; chainId: number; issuedAt: number; nonce: string } | null {
  if (typeof msg !== "string" || msg.length > 600) return null;
  const lines = msg.split("\n");
  if (lines[0] !== LOGIN_TITLE) return null;
  const get = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
  const address = get("Wallet");
  const chainId = Number(get("Chain ID"));
  const issuedAt = Date.parse(get("Issued at") ?? "");
  const nonce = get("Nonce") ?? "";
  if (!address || !isAddress(address) || !Number.isInteger(chainId) || !Number.isFinite(issuedAt) || !/^[0-9a-f]{16,64}$/.test(nonce)) return null;
  // Must be exactly the canonical message (no extra lines a phisher could hide things in).
  if (msg !== loginMessage(address, chainId, new Date(issuedAt), nonce)) return null;
  return { address: getAddress(address), chainId, issuedAt, nonce };
}

/** Single-use nonces, remembered for the login window. */
export class NonceGuard {
  private seen = new Map<string, number>();
  use(nonce: string, now = Date.now()): boolean {
    for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + 2 * LOGIN_MAX_AGE_MS);
    return true;
  }
}

export class Sessions {
  private secret: Buffer;
  private ttlMs: number;
  constructor(secret?: string, ttlMs = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
    this.secret = secret && secret.length >= 32 ? Buffer.from(secret) : randomBytes(32);
  }
  private mac(payload: string) {
    return createHmac("sha256", this.secret).update(payload).digest("hex");
  }
  issue(owner: string, now = Date.now()): { token: string; owner: string; expiresAt: number } {
    const o = owner.toLowerCase();
    const exp = now + this.ttlMs;
    const payload = `${o}.${exp}`;
    return { token: `${payload}.${this.mac(payload)}`, owner: o, expiresAt: exp };
  }
  /** Returns the lowercase owner address, or null if the token is missing, forged or expired. */
  verify(token: string | undefined | null, now = Date.now()): string | null {
    if (!token) return null;
    const m = /^(0x[0-9a-f]{40})\.(\d{10,16})\.([0-9a-f]{64})$/.exec(token);
    if (!m) return null;
    const want = Buffer.from(this.mac(`${m[1]}.${m[2]}`), "hex");
    const got = Buffer.from(m[3], "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (Number(m[2]) < now) return null;
    return m[1];
  }
}

/** Verify a signed sign-in message and return a session. Throws AuthError with a friendly message. */
export async function login(
  input: { message?: unknown; signature?: unknown },
  opts: { chainId: number; nonces: NonceGuard; sessions: Sessions; now?: number; verify?: typeof verifyMessage },
) {
  const now = opts.now ?? Date.now();
  const parsed = parseLoginMessage(String(input.message ?? ""));
  if (!parsed) throw new AuthError("That sign-in message isn't valid. Please try again.");
  if (parsed.chainId !== opts.chainId) throw new AuthError("Wrong network in the sign-in message.");
  if (parsed.issuedAt > now + 2 * 60_000 || now - parsed.issuedAt > LOGIN_MAX_AGE_MS) throw new AuthError("That sign-in expired. Please sign again.");
  const sig = String(input.signature ?? "");
  if (!/^0x[0-9a-fA-F]{130,}$/.test(sig)) throw new AuthError("Missing wallet signature.");
  let ok = false;
  try {
    ok = await (opts.verify ?? verifyMessage)({ address: parsed.address, message: String(input.message), signature: sig as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new AuthError("The signature doesn't match that wallet.");
  if (!opts.nonces.use(parsed.nonce, now)) throw new AuthError("That sign-in was already used. Please sign again.");
  return opts.sessions.issue(parsed.address, now);
}
