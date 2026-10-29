// Saves "request access" emails to Upstash (hash propx:signups: email -> JSON).
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
  const email = String((b && b.email) || "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
  const conf = redisConf();
  if (conf.err) return res.status(500).json({ error: conf.err });
  try {
    const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim().slice(0, 45);
    const bk = "propx:signupburst:" + ip + ":" + Math.floor(Date.now() / 3600000);
    const o = await pipe(conf, [["INCRBY", bk, 1], ["EXPIRE", bk, 7200]]);
    if (Number(o[0]) > 10) return res.status(429).json({ error: "Too many requests. Try again later." });
    await pipe(conf, [["HSETNX", "propx:signups", email, JSON.stringify({ at: new Date().toISOString() })]]);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Couldn't save your request. Try again in a moment." });
  }
};
