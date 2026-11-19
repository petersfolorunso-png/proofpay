import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Brief } from "./brief.ts";
import type { Receipt } from "./verify.ts";

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
    return j;
  }
  addReceipt(jobId: string | bigint, r: Receipt) {
    const j = this.job(jobId);
    j.receipts.push(r);
    j.updatedAt = Date.now();
    this.save();
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
  }
}
