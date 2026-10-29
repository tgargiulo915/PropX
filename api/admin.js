// Admin API for managing customer access keys. Needs ADMIN_SECRET (12+ characters) plus the Upstash env vars.
const crypto = require("crypto");
const PLANS = require("../lib/plans");
const clean = (s) => String(s || "").trim().replace(/^[A-Za-z_]+\s*=\s*/, "").replace(/^["']+|["']+$/g, "").trim();
function redisConf() {
  let u = clean(process.env.UPSTASH_REDIS_REST_URL);
  const t = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!u || !t) return { err: "Usage counter isn't set up yet." };
  if (/^rediss?:\/\//i.test(u)) return { err: "UPSTASH_REDIS_REST_URL is the wrong kind of address. Use the REST URL that starts with https://." };
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return { base: new URL(u).origin, tok: t }; } catch (e) { return { err: "UPSTASH_REDIS_REST_URL isn't a valid web address." }; }
}
async function pipe(conf, cmds) {
  const r = await fetch(conf.base + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + conf.tok, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error("Upstash replied " + r.status);
  const out = await r.json();
  return out.map((o) => { if (o && o.error) throw new Error(o.error); return o.result; });
}
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const KEY_RE = /^px_[a-f0-9]{24}$/;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const secret = (process.env.ADMIN_SECRET || "").trim();
  if (secret.length < 12) return res.status(503).json({ error: "Admin isn't set up. Add ADMIN_SECRET (12 or more characters) in Vercel, then redeploy." });
  const conf = redisConf();
  if (conf.err) return res.status(500).json({ error: conf.err });
  try {
    const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown").replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45) || "unknown";
    const fk = "propx:adminfail:" + ip;
    const [n] = await pipe(conf, [["GET", fk]]);
    if (Number(n) >= 10) return res.status(429).json({ error: "Too many wrong attempts. Try again in an hour." });
    if (!same(req.headers["x-admin-secret"] || "", secret)) {
      await pipe(conf, [["INCR", fk], ["EXPIRE", fk, 3600]]);
      return res.status(401).json({ error: "Wrong admin secret." });
    }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const month = new Date().toISOString().slice(0, 7);
    const action = body.action;

    if (action === "create") {
      const name = String(body.name || "").trim().slice(0, 80);
      const limit = Math.max(0, Math.min(100000, parseInt(body.limit, 10) || 0));
      if (!name || !limit) return res.status(400).json({ error: "Enter a customer name and a monthly search limit above 0." });
      const key = "px_" + crypto.randomBytes(12).toString("hex");
      await pipe(conf, [["SET", "propx:cust:" + key, JSON.stringify({ name, limit, active: true, created: new Date().toISOString() })], ["SADD", "propx:custs", key]]);
      return res.status(200).json({ key, name, limit });
    }

    if (action === "list") {
      const [keys] = await pipe(conf, [["SMEMBERS", "propx:custs"]]);
      const cmds = (keys || []).map((k) => ["GET", "propx:cust:" + k]).concat((keys || []).map((k) => ["GET", "propx:use:" + k + ":" + month]), [["GET", "propx:rentcast:" + month]]);
      const rows = cmds.length ? await pipe(conf, cmds) : [];
      const len = (keys || []).length;
      const customers = (keys || []).map((k, i) => {
        let c = {};
        try { c = JSON.parse(rows[i] || "{}"); } catch (e) { /* ignore */ }
        return { key: k, name: c.name || "(unnamed)", email: c.email || "", plan: c.plan || "", note: c.note || "", limit: Number(c.limit) || 0, active: c.active !== false, used: Number(rows[len + i]) || 0, created: c.created || "" };
      }).sort((a, b) => (a.created < b.created ? 1 : -1));
      const cap = parseInt(process.env.MONTHLY_REQUEST_LIMIT || "45", 10);
      const mrr = customers.reduce((s, c) => { const p = PLANS.find((x) => x.id === c.plan); return s + (c.active && p ? p.price : 0); }, 0);
      return res.status(200).json({ customers, month, summary: { active: customers.filter((c) => c.active).length, total: customers.length, mrr }, rentcast: { used: Number(rows[len * 2]) || 0, limit: cap } });
    }

    if (action === "update") {
      const key = String(body.key || "");
      if (!KEY_RE.test(key)) return res.status(400).json({ error: "Invalid key." });
      const [raw] = await pipe(conf, [["GET", "propx:cust:" + key]]);
      if (!raw) return res.status(404).json({ error: "No customer has that key." });
      const c = JSON.parse(raw);
      if (body.limit !== undefined) c.limit = Math.max(0, Math.min(100000, parseInt(body.limit, 10) || 0));
      if (body.active !== undefined) c.active = !!body.active;
      if (body.note !== undefined) c.note = String(body.note).trim().slice(0, 200);
      if (body.name !== undefined) c.name = String(body.name).trim().slice(0, 80) || c.name;
      await pipe(conf, [["SET", "propx:cust:" + key, JSON.stringify(c)]]);
      return res.status(200).json({ ok: true });
    }

    if (action === "signups") {
      const [h] = await pipe(conf, [["HGETALL", "propx:signups"]]);
      const list = [];
      for (let i = 0; h && i < h.length; i += 2) { let at = ""; try { at = JSON.parse(h[i + 1]).at || ""; } catch (e) { /* ignore */ } list.push({ email: h[i], at }); }
      list.sort((x, y) => (x.at < y.at ? 1 : -1));
      return res.status(200).json({ signups: list.slice(0, 500) });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: "Admin error: " + (e && e.message ? e.message : "unknown") });
  }
};
