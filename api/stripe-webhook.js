// Stripe webhook: turns a payment into an access key, and turns a cancellation into a turned-off key.
// Needs STRIPE_SECRET_KEY plus the Upstash env vars. Point a Stripe webhook at /api/stripe-webhook for these events:
//   checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
// Security: the request body is never trusted. We only take the event id from it and fetch the real event from Stripe.
const crypto = require("crypto");
const PLANS = require("../lib/plans");
const clean = (s) => String(s || "").trim().replace(/^[A-Za-z_]+\s*=\s*/, "").replace(/^["']+|["']+$/g, "").trim();
function redisConf() {
  let u = clean(process.env.UPSTASH_REDIS_REST_URL);
  const t = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!u || !t) return { err: "Usage counter isn't set up yet." };
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return { base: new URL(u).origin, tok: t }; } catch (e) { return { err: "UPSTASH_REDIS_REST_URL isn't a valid web address." }; }
}
async function pipe(conf, cmds) {
  const r = await fetch(conf.base + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + conf.tok, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error("Upstash replied " + r.status);
  const out = await r.json();
  return out.map((o) => { if (o && o.error) throw new Error(o.error); return o.result; });
}
async function stripe(path, sk) {
  const r = await fetch("https://api.stripe.com/v1" + path, { headers: { Authorization: "Bearer " + sk } });
  if (!r.ok) throw new Error("Stripe replied " + r.status + " for " + path);
  return r.json();
}
// Match what was bought to a plan: price id from env (STRIPE_PRICE_<PLANID>) first, then the price in cents.
function planFor(price) {
  if (!price) return null;
  const byId = PLANS.find((p) => clean(process.env["STRIPE_PRICE_" + p.id.toUpperCase()]) === price.id);
  if (byId) return byId;
  return PLANS.find((p) => Math.round(p.price * 100) === Number(price.unit_amount)) || null;
}
const newKey = () => "px_" + crypto.randomBytes(12).toString("hex");

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const sk = clean(process.env.STRIPE_SECRET_KEY);
  if (!sk) return res.status(503).json({ error: "Billing isn't set up. Add STRIPE_SECRET_KEY in Vercel." });
  const conf = redisConf();
  if (conf.err) return res.status(500).json({ error: conf.err });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const id = body && typeof body.id === "string" ? body.id : "";
  if (!/^evt_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Missing event id." });
  try {
    const ev = await stripe("/events/" + id, sk); // the real event, straight from Stripe
    const obj = ev && ev.data && ev.data.object;
    if (!obj) return res.status(200).json({ ok: true, ignored: true });

    if (ev.type === "checkout.session.completed") {
      if (obj.mode !== "subscription" || obj.payment_status === "unpaid") return res.status(200).json({ ok: true, ignored: true });
      const [existing] = await pipe(conf, [["GET", "propx:sess:" + obj.id]]);
      if (existing) return res.status(200).json({ ok: true, duplicate: true });
      const items = await stripe("/checkout/sessions/" + obj.id + "/line_items?limit=5", sk);
      const price = items.data && items.data[0] && items.data[0].price;
      const plan = planFor(price);
      const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || "";
      const key = newKey();
      const cust = {
        name: email || "Stripe customer", email, limit: plan ? plan.searches : PLANS[0].searches, active: true,
        plan: plan ? plan.id : "unmatched", created: new Date().toISOString(),
        stripe: { customer: obj.customer || "", subscription: obj.subscription || "", session: obj.id },
      };
      const cmds = [["SET", "propx:cust:" + key, JSON.stringify(cust)], ["SADD", "propx:custs", key], ["SET", "propx:sess:" + obj.id, key, "EX", 2592000]];
      if (obj.subscription) cmds.push(["SET", "propx:sub:" + obj.subscription, key]);
      await pipe(conf, cmds);
      return res.status(200).json({ ok: true, created: true, plan: cust.plan });
    }

    if (ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
      const [key] = await pipe(conf, [["GET", "propx:sub:" + obj.id]]);
      if (!key) return res.status(200).json({ ok: true, unknown: true });
      const [raw] = await pipe(conf, [["GET", "propx:cust:" + key]]);
      if (!raw) return res.status(200).json({ ok: true, unknown: true });
      const c = JSON.parse(raw);
      const live = ev.type === "customer.subscription.updated" && ["active", "trialing", "past_due"].includes(obj.status);
      c.active = live;
      if (live) {
        const plan = planFor(obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price);
        if (plan) { c.limit = plan.searches; c.plan = plan.id; }
      }
      await pipe(conf, [["SET", "propx:cust:" + key, JSON.stringify(c)]]);
      return res.status(200).json({ ok: true, active: c.active });
    }
    return res.status(200).json({ ok: true, ignored: true });
  } catch (e) {
    return res.status(500).json({ error: "Webhook error: " + (e && e.message ? e.message : "unknown") });
  }
};
