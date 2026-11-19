/**
 * Durable storage off local disk (Render's free disk is wiped on restart).
 * Talks to the `proofpay-store` Worker (../store-worker/worker.js) on Cloudflare D1 (free tier).
 * The server is the only writer; it does all validation and wallet-signature checks first.
 */
import { ContactError, type ContactBackend } from "./contacts.ts";
import type { Contact } from "./brief.ts";

type FetchFn = typeof fetch;

export class RemoteClient {
  readonly url: string;
  private token: string;
  private fetchFn: FetchFn;
  constructor(url: string, token: string, fetchFn: FetchFn = fetch) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetchFn = fetchFn;
  }
  async call(method: string, path: string, body?: string, okStatuses: number[] = []): Promise<Response> {
    let wait = 400;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.fetchFn(`${this.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (r.ok || okStatuses.includes(r.status)) return r;
        if (r.status < 500 && r.status !== 429) throw Object.assign(new Error(`store refused ${method} ${path.split("/")[1]}: HTTP ${r.status}`), { fatal: true });
        if (attempt >= 4) throw new Error(`store unavailable: HTTP ${r.status}`);
      } catch (e: any) {
        if (e?.fatal || attempt >= 4) throw e;
      }
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(wait * 2, 4000);
    }
  }
}

/** Write-behind document store (briefs, job records). Writes per key are coalesced, latest wins. */
export class RemoteDocs {
  private pending = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  private client: RemoteClient;
  constructor(client: RemoteClient) {
    this.client = client;
  }

  async load(): Promise<Record<string, string>> {
    const r = await this.client.call("GET", "/docs");
    return ((await r.json()) as { docs?: Record<string, string> }).docs ?? {};
  }

  put(key: string, json: string): Promise<void> {
    this.pending.set(key, json);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      while (this.pending.has(key)) {
        const body = this.pending.get(key)!;
        this.pending.delete(key);
        try {
          await this.client.call("PUT", `/docs/${encodeURIComponent(key)}`, body);
        } catch (e) {
          console.error(`[proofpay] store write failed for ${key}: ${(e as Error).message}`);
        }
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }
}

/** Saved people per owner (a lowercase wallet address, or "demo") on D1. */
export class RemoteContacts implements ContactBackend {
  readonly kind = "d1";
  private client: RemoteClient;
  constructor(client: RemoteClient) {
    this.client = client;
  }
  async list(owner: string): Promise<Record<string, Contact>> {
    const r = await this.client.call("GET", `/contacts/${owner}`);
    const rows = ((await r.json()) as { contacts?: { name: string; address: `0x${string}`; handle: string }[] }).contacts ?? [];
    return Object.fromEntries(rows.map((x) => [x.name, { address: x.address, handle: x.handle }]));
  }
  async put(owner: string, name: string, c: { address: `0x${string}`; handle: string }, _max: number): Promise<void> {
    const r = await this.client.call("PUT", `/contacts/${owner}/${name}`, JSON.stringify(c), [409]);
    if (r.status === 409) throw new ContactError(400, `Saved people is full (${_max}). Remove someone first.`);
  }
  async del(owner: string, name: string): Promise<boolean> {
    const r = await this.client.call("DELETE", `/contacts/${owner}/${name}`, undefined, [404]);
    return r.status !== 404;
  }
}
