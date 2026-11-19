import { getAddress, isAddress } from "viem";
import { hashJson } from "./canonical.ts";
import type { LLMProvider } from "./llm.ts";

export type Platform = "x" | "github" | "web";

export interface Brief {
  version: 1;
  title: string;
  originalText: string;
  payee: `0x${string}`;
  payeeHandle?: string; // X/GitHub handle the proof must come from
  amount: string; // decimal tUSD8, e.g. "50"
  deadline: number; // unix seconds
  proof: {
    platform: Platform;
    authorHandle?: string;
    mustInclude: string[]; // phrases / #hashtags / @mentions that must appear
    mustLinkTo: string[]; // domains or URLs that must be linked
    postedAfterCreation: boolean;
    notes?: string; // free-text condition judged by the AI
  };
  createdAt: number;
}

export interface Contact {
  address: `0x${string}`;
  handle?: string;
}

export interface ParseResult {
  brief: Brief;
  briefHash: `0x${string}`;
  warnings: string[];
  parser: "llm+rules" | "rules";
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseDeadline(text: string, now: Date): number {
  const t = text.toLowerCase();
  const sec = Math.floor(now.getTime() / 1000);
  let m = t.match(/\b(?:in|within)\s+(\d{1,3})\s*(minute|min|hour|hr|day|week)s?\b/);
  if (m) {
    const n = Number(m[1]);
    const unit = { minute: 60, min: 60, hour: 3600, hr: 3600, day: 86400, week: 604800 }[m[2]]!;
    return sec + n * unit;
  }
  if (/\b(by|before)\s+tonight\b/.test(t)) {
    const d = new Date(now);
    d.setHours(23, 59, 0, 0);
    return Math.max(Math.floor(d.getTime() / 1000), sec + 3600);
  }
  if (/\b(by|before)\s+tomorrow\b/.test(t)) return sec + 86400;
  m = t.match(/\b(?:by|before|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (m) {
    const target = WEEKDAYS.indexOf(m[1]);
    const d = new Date(now);
    let add = (target - d.getDay() + 7) % 7;
    if (add === 0) add = 7;
    d.setDate(d.getDate() + add);
    d.setHours(23, 59, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  return sec + 3 * 86400; // default: 3 days
}

/** Deterministic parser. Money fields (payee, amount) ALWAYS come from here, never from the LLM. */
export function parseRules(text: string, contacts: Record<string, Contact>, now = new Date()): ParseResult {
  const warnings: string[] = [];
  const clean = text.trim().slice(0, 1000);

  // Payee: explicit address wins, else "pay @name" looked up in the address book.
  const addrs = [...new Set(clean.match(/0x[a-fA-F0-9]{40}/g) ?? [])];
  const payMatch = clean.match(/\bpay\s+@?([A-Za-z0-9_]{1,30})/i);
  const payeeHandle = payMatch && !payMatch[1].startsWith("0x") ? payMatch[1] : undefined;
  let payee: `0x${string}` | undefined;
  let handle = payeeHandle;
  if (addrs.length > 1) warnings.push("More than one address in the text; using the first. Please check.");
  if (addrs.length && isAddress(addrs[0])) payee = getAddress(addrs[0]);
  else if (payeeHandle && contacts[payeeHandle.toLowerCase()]) {
    const c = contacts[payeeHandle.toLowerCase()];
    payee = c.address;
    handle = c.handle ?? payeeHandle;
  }
  if (!payee) throw new Error("Who should get paid? Add their 0x wallet address or a saved contact like @ada.");

  // Amount: "50 tUSD8", "50 usd", "$50", "50 dollars".
  const am =
    clean.match(/\$\s?(\d+(?:\.\d{1,6})?)/) ??
    clean.match(/(\d+(?:\.\d{1,6})?)\s*(?:t?usd8?|tusd|dollars?|bucks)\b/i);
  if (!am) throw new Error("How much? Add an amount like '50 tUSD8'.");
  const amount = String(Number(am[1]));
  if (!(Number(amount) > 0)) throw new Error("Amount must be more than 0.");

  const lower = clean.toLowerCase();
  const platform: Platform = /github|pull request|\bpr\b|commit|repo/.test(lower)
    ? "github"
    : /tweet|\bx\b|x\.com|twitter|\bpost\b|thread/.test(lower)
      ? "x"
      : "web";

  // Requirements: "quoted phrases", #hashtags, @mentions (excluding the payee) and links.
  const quoted = [...clean.matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1].trim());
  const tags = clean.match(/#[A-Za-z0-9_]{2,40}/g) ?? [];
  const mentions = (clean.match(/@[A-Za-z0-9_]{2,30}/g) ?? []).filter(
    (m) => ![handle, payeeHandle].some((h) => h && m.slice(1).toLowerCase() === h.toLowerCase()),
  );
  const links = (clean.match(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:io|com|xyz|info|org|net|app|dev|fyi)(?:\/[^\s,]*)?/gi) ?? [])
    .filter((l) => !/^0x/i.test(l) && !/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter|github)\.com\/?$/i.test(l))
    .map((l) => l.replace(/[.,)]+$/, ""));
  const mustInclude = [...new Set([...quoted, ...tags, ...mentions])];
  if (!mustInclude.length && !links.length)
    warnings.push("No concrete proof check found (quote a phrase, #hashtag, @mention or link). The AI will judge the free text only.");

  const deadline = parseDeadline(clean, now);
  const brief: Brief = {
    version: 1,
    title: clean.length > 90 ? clean.slice(0, 87) + "..." : clean,
    originalText: clean,
    payee,
    payeeHandle: handle,
    amount,
    deadline,
    proof: {
      platform,
      authorHandle: platform !== "web" ? handle : undefined,
      mustInclude,
      mustLinkTo: [...new Set(links)],
      postedAfterCreation: true,
      notes: clean,
    },
    createdAt: Math.floor(now.getTime() / 1000),
  };
  return { brief, briefHash: hashJson(brief), warnings, parser: "rules" };
}

const PARSE_SYSTEM = `You turn a client's payment request into proof requirements for an escrow.
Return ONLY JSON: {"title": string (<=80 chars, plain summary), "mustInclude": string[] (exact phrases, #hashtags or @mentions the proof must contain), "mustLinkTo": string[] (domains or URLs the proof must link), "notes": string (one sentence describing what counts as done)}.
Only use requirements stated in the request. Never add new ones. Do not output amounts, addresses or deadlines.`;

/** LLM refines the human-readable requirements; money fields stay deterministic. */
export async function parseBrief(
  text: string,
  contacts: Record<string, Contact>,
  llm: LLMProvider | null,
  now = new Date(),
): Promise<ParseResult> {
  const base = parseRules(text, contacts, now);
  if (!llm) return base;
  try {
    const out: any = await llm.generateJson(PARSE_SYSTEM, `Request:\n${base.brief.originalText}`);
    const strs = (a: unknown) =>
      Array.isArray(a) ? a.filter((s) => typeof s === "string" && s.length <= 120).slice(0, 8) : [];
    const lower = base.brief.originalText.toLowerCase();
    // Keep only LLM requirements that literally appear in the client's text (no hallucinated conditions).
    const grounded = (s: string) => lower.includes(s.toLowerCase().replace(/^https?:\/\//, ""));
    // The payee's own name/handle is who posts, not something the post must contain.
    const payName = base.brief.originalText.match(/\bpay\s+@?([A-Za-z0-9_]{1,30})/i)?.[1]?.toLowerCase();
    const selfRefs = new Set([payName, base.brief.payeeHandle?.toLowerCase()].filter(Boolean).map((h) => "@" + h));
    const inc = strs(out?.mustInclude).filter((t) => grounded(t) && !selfRefs.has(t.toLowerCase()) && !/^0x[0-9a-f]{40}$/i.test(t));
    const links = strs(out?.mustLinkTo).filter(grounded);
    const brief: Brief = {
      ...base.brief,
      title: typeof out?.title === "string" && out.title.trim() ? out.title.trim().slice(0, 90) : base.brief.title,
      proof: {
        ...base.brief.proof,
        mustInclude: [...new Set([...base.brief.proof.mustInclude, ...inc])],
        mustLinkTo: [...new Set([...base.brief.proof.mustLinkTo, ...links])],
        notes: typeof out?.notes === "string" ? out.notes.slice(0, 300) : base.brief.proof.notes,
      },
    };
    const warnings = base.warnings.filter((w) => !(w.startsWith("No concrete") && (inc.length || links.length)));
    return { brief, briefHash: hashJson(brief), warnings, parser: "llm+rules" };
  } catch (e) {
    return { ...base, warnings: [...base.warnings, `AI parser unavailable (${(e as Error).message}); used rules.`] };
  }
}
