// Saves sign-ups (name, email, company) to Upstash: hash propx:signups, email -> JSON with status pending/approved/rejected.
const clean = (s) => String(s || "").trim().replace(/^[A-Za-z_]+\s*=\s*/, "").replace(/^["']+|["']+$/g, "").trim();
function redisConf() {
  let u = clean(process.env.UPSTASH_REDIS_REST_URL);
  const t = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!u || !t) return { err: "Signups aren't set up yet." };
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
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const email = String(b.email || "").trim().toLowerCase();
  const name = String(b.name || "").trim().slice(0, 80);
  const company = String(b.company || "").trim().slice(0, 80);
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  if (!name) return res.status(400).json({ error: "Enter your name." });
  const conf = redisConf();
  if (conf.err) return res.status(500).json({ error: conf.err });
  try {
    const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim().slice(0, 45);
    const bk = "propx:signupburst:" + ip + ":" + Math.floor(Date.now() / 3600000);
    const o = await pipe(conf, [["INCRBY", bk, 1], ["EXPIRE", bk, 7200]]);
    if (Number(o[0]) > 10) return res.status(429).json({ error: "Too many requests. Try again later." });
    const [prev] = await pipe(conf, [["HGET", "propx:signups", email]]);
    let rec = {};
    try { rec = prev ? JSON.parse(prev) : {}; } catch (e) { rec = {}; }
    rec = { ...rec, email, name, company, at: rec.at || new Date().toISOString(), status: rec.status || "pending" };
    await pipe(conf, [["HSET", "propx:signups", email, JSON.stringify(rec)]]);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Couldn't save your request. Try again in a moment." });
  }
};
