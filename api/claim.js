// After paying, the welcome page asks for the new key using the Stripe checkout session id from the redirect.
const clean = (s) => String(s || "").trim().replace(/^[A-Za-z_]+\s*=\s*/, "").replace(/^["']+|["']+$/g, "").trim();
function redisConf() {
  let u = clean(process.env.UPSTASH_REDIS_REST_URL);
  const t = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!u || !t) return { err: "Usage counter isn't set up yet." };
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return { base: new URL(u).origin, tok: t }; } catch (e) { return { err: "Bad Upstash address." }; }
}
async function pipe(conf, cmds) {
  const r = await fetch(conf.base + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + conf.tok, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error("Upstash replied " + r.status);
  const out = await r.json();
  return out.map((o) => { if (o && o.error) throw new Error(o.error); return o.result; });
}
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const sid = String(req.query.session_id || "");
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) return res.status(400).json({ error: "Missing or invalid session." });
  const conf = redisConf();
  if (conf.err) return res.status(500).json({ error: conf.err });
  try {
    const [key] = await pipe(conf, [["GET", "propx:sess:" + sid]]);
    if (!key) return res.status(200).json({ pending: true });
    const [raw] = await pipe(conf, [["GET", "propx:cust:" + key]]);
    const c = raw ? JSON.parse(raw) : {};
    return res.status(200).json({ key, plan: c.plan || "", limit: Number(c.limit) || 0 });
  } catch (e) {
    return res.status(500).json({ error: "Couldn't look that up. Try again in a moment." });
  }
};
