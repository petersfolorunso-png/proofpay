import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { keccak256, toBytes } from "viem";
import { config } from "./config.ts";

export interface ProofSnapshot {
  url: string;
  kind: "x" | "web" | "fixture";
  ok: boolean;
  error?: string;
  author?: string; // handle without @
  authorName?: string;
  createdAt?: number; // unix seconds
  title?: string;
  text: string; // untrusted content, truncated
  links: string[];
  contentHash: `0x${string}`;
  fetchedAt: number;
}

const MAX_BYTES = 400_000;
const MAX_TEXT = 6_000;
const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80")) return true;
    const v4 = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return v4 ? isPrivateIp(v4[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

/** SSRF guard: public http(s) only, no credentials, no private/loopback/link-local targets. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  if (raw.length > 512) throw new Error("URL too long");
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) links are accepted");
  if (u.username || u.password) throw new Error("Links with credentials are not accepted");
  if (u.port && !["80", "443"].includes(u.port)) throw new Error("Non-standard ports are not accepted");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private host");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Link resolves to a private address");
  return u;
}

const hashText = (s: string) => keccak256(toBytes(s));

function stripHtml(html: string): { title?: string; text: string; links: string[] } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const ogDesc = html.match(/<meta[^>]+(?:property|name)=["'](?:og:)?description["'][^>]+content=["']([^"']*)["']/i)?.[1];
  const links = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]).slice(0, 50);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text: [ogDesc, text].filter(Boolean).join(" \n ").slice(0, MAX_TEXT), links };
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** X posts: public syndication endpoint (no login, no API key). */
async function fetchXPost(u: URL): Promise<Omit<ProofSnapshot, "fetchedAt" | "contentHash">> {
  const id = u.pathname.match(/\/status(?:es)?\/(\d{1,25})/)?.[1];
  if (!id) throw new Error("Not an X post link (expected x.com/<user>/status/<id>)");
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { "user-agent": "ProofPayVerifier/0.1" },
  });
  if (res.status === 404) throw new Error("Post not found or not public");
  if (!res.ok) throw new Error(`X returned HTTP ${res.status}`);
  const t: any = JSON.parse(await readCapped(res));
  if (t?.__typename === "TweetTombstone" || !t?.text) throw new Error("Post is deleted, private or age-restricted");
  const links: string[] = (t.entities?.urls ?? []).map((x: any) => x.expanded_url).filter(Boolean);
  const pathUser = u.pathname.split("/")[1];
  const author = t.user?.screen_name as string | undefined;
  if (author && pathUser && pathUser !== "i" && pathUser.toLowerCase() !== author.toLowerCase()) {
    throw new Error(`Link says @${pathUser} but the post is by @${author}`);
  }
  let text: string = t.text;
  for (const x of t.entities?.urls ?? []) if (x.url && x.expanded_url) text = text.replaceAll(x.url, x.expanded_url);
  if (t.quoted_tweet?.text) text += `\n[quoted @${t.quoted_tweet.user?.screen_name}: ${t.quoted_tweet.text}]`;
  return {
    url: u.toString(),
    kind: "x",
    ok: true,
    author,
    authorName: t.user?.name,
    createdAt: t.created_at ? Math.floor(Date.parse(t.created_at) / 1000) : undefined,
    text: text.slice(0, MAX_TEXT),
    links,
  };
}

async function fetchWeb(u: URL): Promise<Omit<ProofSnapshot, "fetchedAt" | "contentHash">> {
  let cur = u;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(cur.toString());
    const res = await fetch(cur, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "ProofPayVerifier/0.1", accept: "text/html,text/plain,application/json" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location")!, cur);
      continue;
    }
    if (!res.ok) throw new Error(`Page returned HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/.test(ct)) throw new Error(`Unsupported content type ${ct}`);
    const body = await readCapped(res);
    const { title, text, links } = /html/.test(ct) ? stripHtml(body) : { title: undefined, text: body.slice(0, MAX_TEXT), links: [] };
    const gh = cur.hostname === "github.com" ? cur.pathname.split("/")[1] : undefined;
    return { url: u.toString(), kind: "web", ok: true, title, text, links, author: gh };
  }
  throw new Error("Too many redirects");
}

export async function fetchProof(rawUrl: string): Promise<ProofSnapshot> {
  const fetchedAt = Math.floor(Date.now() / 1000);
  try {
    let snap: Omit<ProofSnapshot, "fetchedAt" | "contentHash">;
    if (rawUrl.startsWith("fixture://")) {
      if (!config.proofFixturesDir) throw new Error("fixtures disabled");
      const f = JSON.parse(readFileSync(join(config.proofFixturesDir, basename(rawUrl.slice(10)) + ".json"), "utf8"));
      snap = { links: [], ...f, url: rawUrl, kind: "fixture", ok: true };
    } else {
      const u = await assertPublicUrl(rawUrl.trim());
      snap = X_HOSTS.has(u.hostname.toLowerCase()) ? await fetchXPost(u) : await fetchWeb(u);
    }
    return { ...snap, fetchedAt, contentHash: hashText(JSON.stringify([snap.author, snap.createdAt, snap.text])) };
  } catch (e) {
    return { url: rawUrl, kind: "web", ok: false, error: (e as Error).message, text: "", links: [], fetchedAt, contentHash: hashText("") };
  }
}
