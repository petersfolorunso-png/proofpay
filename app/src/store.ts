import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Brief } from "./brief.ts";
import type { Receipt } from "./verify.ts";
import { hashJson } from "./canonical.ts";

/** Anything that can durably keep a JSON doc by key (see remote.ts). */
export interface DocSink {
  put(key: string, json: string): Promise<void>;
}

export interface JobRecord {
  jobId: string;
  brief?: Brief;
  briefHash?: string;
  createTx?: string;
  fundTx?: string;
  proofUrl?: string;
  proofTx?: string;
  receipts: Receipt[];
  agentState?: "idle" | "verifying" | "needs_human" | "done" | "error";
  agentNote?: string;
  lastActionTx?: string;
  updatedAt: number;
}

interface DB {
  briefs: Record<string, Brief>; // briefHash -> brief
  jobs: Record<string, JobRecord>;
  lastScannedBlock?: string;
}

/** Tiny JSON file store with atomic writes. Chain is the source of truth; this only caches off-chain data. */
export class Store {
  private file: string;
  private db: DB;
  constructor(dir = config.dataDir) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "db.json");
    this.db = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { briefs: {}, jobs: {} };
  }
  private remote: DocSink | null = null;
  private remoteBriefs = new Set<string>();
  private lastScanPushed = 0;

  /**
   * Hydrate from the durable store and write through to it from now on. Briefs are only kept durably
   * once a job references them (see markBriefUsed), so abandoned drafts don't pile up.
   */
  attachRemote(remote: DocSink, docs: Record<string, string>) {
    this.remote = remote;
    for (const [k, v] of Object.entries(docs)) {
      try {
        if (k.startsWith("brief:")) {
          const brief = JSON.parse(v) as Brief;
          const h = k.slice(6).toLowerCase();
          if (hashJson(brief).toLowerCase() !== h) continue; // content-addressed: ignore anything tampered
          this.db.briefs[h] = brief;
          this.remoteBriefs.add(h);
        } else if (k.startsWith("job:")) {
          const rec = JSON.parse(v) as JobRecord;
          const id = k.slice(4);
          const local = this.db.jobs[id];
          if (!local || (rec.updatedAt ?? 0) >= (local.updatedAt ?? 0)) this.db.jobs[id] = { ...rec, jobId: id, receipts: rec.receipts ?? [] };
        } else if (k === "meta:lastScannedBlock") {
          const b = BigInt(JSON.parse(v));
          if (!this.db.lastScannedBlock || b > BigInt(this.db.lastScannedBlock)) this.db.lastScannedBlock = b.toString();
        }
      } catch {
        /* skip a bad doc */
      }
    }
    this.save();
  }
  get durable(): boolean {
    return !!this.remote;
  }
  private push(key: string, value: unknown) {
    this.remote?.put(key, JSON.stringify(value)).catch(() => undefined);
  }
  /** A job on chain references this brief: keep it durably. */
  markBriefUsed(hash: string) {
    const h = hash.toLowerCase();
    if (!this.remote || this.remoteBriefs.has(h) || !this.db.briefs[h]) return;
    this.remoteBriefs.add(h);
    this.push(`brief:${h}`, this.db.briefs[h]);
  }

  private save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.file);
  }
  putBrief(hash: string, brief: Brief) {
    this.db.briefs[hash.toLowerCase()] = brief;
    this.save();
  }
  getBrief(hash: string): Brief | undefined {
    return this.db.briefs[hash.toLowerCase()];
  }
  job(jobId: string | bigint): JobRecord {
    const id = jobId.toString();
    return (this.db.jobs[id] ??= { jobId: id, receipts: [], updatedAt: Date.now() });
  }
  updateJob(jobId: string | bigint, patch: Partial<JobRecord>): JobRecord {
    const j = this.job(jobId);
    Object.assign(j, patch, { updatedAt: Date.now() });
    this.save();
    this.push(`job:${j.jobId}`, j);
    return j;
  }
  addReceipt(jobId: string | bigint, r: Receipt) {
    const j = this.job(jobId);
    j.receipts.push(r);
    j.updatedAt = Date.now();
    this.save();
    this.push(`job:${j.jobId}`, j);
  }
  allJobs(): JobRecord[] {
    return Object.values(this.db.jobs);
  }
  get lastScannedBlock(): bigint | undefined {
    return this.db.lastScannedBlock ? BigInt(this.db.lastScannedBlock) : undefined;
  }
  set lastScannedBlock(b: bigint | undefined) {
    this.db.lastScannedBlock = b?.toString();
    this.save();
    // Throttled: the watcher ticks every few seconds; D1 doesn't need every one.
    if (b !== undefined && Date.now() - this.lastScanPushed > 60_000) {
      this.lastScanPushed = Date.now();
      this.push("meta:lastScannedBlock", b.toString());
    }
  }
}
