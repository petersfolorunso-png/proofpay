// ProofPay store: a tiny authenticated store on Cloudflare D1 (free tier).
// Bindings: DB (D1), TOKEN (secret). Single writer: the ProofPay server, which does all
// validation and wallet-signature checks before calling this.
//   GET    /docs                    -> { docs: { [key]: jsonString } }   (briefs, job records)
//   PUT    /docs/:key               <- jsonString
//   GET    /contacts/:owner         -> { contacts: [{ name, address, handle }] }
//   PUT    /contacts/:owner/:name   <- { address, handle }   (max 200 per owner)
//   DELETE /contacts/:owner/:name
const enc = new TextEncoder();
const MAX_CONTACTS = 200;
async function same(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const OWNER = "(demo|0x[0-9a-f]{40})";
const NAME = "([a-z0-9_]{1,30})";
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return json({ error: "bad path" }, 400); }
    if (path === "/health") return json({ ok: true });
    const auth = req.headers.get("authorization") ?? "";
    if (!env.TOKEN || !(await same(auth, `Bearer ${env.TOKEN}`))) return json({ error: "unauthorized" }, 401);

    if (req.method === "GET" && path === "/docs") {
      const { results } = await env.DB.prepare("SELECT k, v FROM docs").all();
      return json({ docs: Object.fromEntries(results.map((r) => [r.k, r.v])) });
    }
    let m = path.match(/^\/docs\/([A-Za-z0-9._:-]{1,96})$/);
    if (m && req.method === "PUT") {
      const v = await req.text();
      if (v.length > 200_000) return json({ error: "too large" }, 413);
      try { JSON.parse(v); } catch { return json({ error: "not json" }, 400); }
      await env.DB.prepare("INSERT INTO docs (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(m[1], v, Date.now()).run();
      return json({ ok: true });
    }

    m = path.match(new RegExp(`^/contacts/${OWNER}$`));
    if (m && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT name, address, handle FROM contacts WHERE owner = ?1 ORDER BY name").bind(m[1]).all();
      return json({ contacts: results });
    }
    m = path.match(new RegExp(`^/contacts/${OWNER}/${NAME}$`));
    if (m && req.method === "PUT") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "not json" }, 400); }
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(b.address ?? "")) || !/^[a-z0-9_]{1,30}$/.test(String(b.handle ?? ""))) return json({ error: "bad contact" }, 400);
      const exists = await env.DB.prepare("SELECT 1 FROM contacts WHERE owner = ?1 AND name = ?2").bind(m[1], m[2]).first();
      if (!exists) {
        const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE owner = ?1").bind(m[1]).first();
        if ((row?.n ?? 0) >= MAX_CONTACTS) return json({ error: "full" }, 409);
      }
      await env.DB.prepare("INSERT INTO contacts (owner, name, address, handle, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(owner, name) DO UPDATE SET address = excluded.address, handle = excluded.handle, updated_at = excluded.updated_at").bind(m[1], m[2], b.address, b.handle, Date.now()).run();
      return json({ ok: true });
    }
    if (m && req.method === "DELETE") {
      const r = await env.DB.prepare("DELETE FROM contacts WHERE owner = ?1 AND name = ?2").bind(m[1], m[2]).run();
      return r.meta?.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
    }
    return json({ error: "not found" }, 404);
  },
};
