/**
 * Who is on each job (client, payee). These never change after creation, so we read each job from the
 * escrow once and cache it; "My jobs" then filters by wallet without trusting any local JSON.
 */
export interface Parties {
  client: string;
  payee: string;
  briefHash: string;
}

export class JobIndex {
  private parties = new Map<bigint, Parties>();
  private known = 0n;
  private refreshing: Promise<void> | null = null;
  private readCount: () => Promise<bigint>;
  private readParties: (id: bigint) => Promise<Parties | null>;
  private onNew: (id: bigint, p: Parties) => void;
  private concurrency: number;
  constructor(
    readCount: () => Promise<bigint>,
    readParties: (id: bigint) => Promise<Parties | null>,
    onNew: (id: bigint, p: Parties) => void = () => {},
    concurrency = 6,
  ) {
    this.readCount = readCount;
    this.readParties = readParties;
    this.onNew = onNew;
    this.concurrency = concurrency;
  }

  /** Read any jobs created since the last refresh. Concurrent callers share one refresh. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh() {
    const count = await this.readCount();
    const todo: bigint[] = [];
    for (let i = this.known + 1n; i <= count; i++) if (!this.parties.has(i)) todo.push(i);
    let failed = false;
    for (let k = 0; k < todo.length; k += this.concurrency) {
      const batch = todo.slice(k, k + this.concurrency);
      const got = await Promise.all(batch.map((id) => this.readParties(id).catch(() => null)));
      got.forEach((p, i) => {
        if (p) {
          const norm = { client: p.client.toLowerCase(), payee: p.payee.toLowerCase(), briefHash: p.briefHash.toLowerCase() };
          this.parties.set(batch[i], norm);
          this.onNew(batch[i], norm);
        } else failed = true;
      });
    }
    // Only advance past ids we actually have, so a flaky read is retried next time.
    if (!failed) this.known = count;
  }

  /** Job ids (newest first) where `wallet` is the client or the payee. */
  async forWallet(wallet: string, limit = 50): Promise<{ id: bigint; role: "client" | "payee" | "both" }[]> {
    await this.refresh();
    const w = wallet.toLowerCase();
    const out: { id: bigint; role: "client" | "payee" | "both" }[] = [];
    const ids = [...this.parties.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    for (const id of ids) {
      const p = this.parties.get(id)!;
      const c = p.client === w;
      const y = p.payee === w;
      if (c || y) out.push({ id, role: c && y ? "both" : c ? "client" : "payee" });
      if (out.length >= limit) break;
    }
    return out;
  }

  get size() {
    return this.parties.size;
  }
}
