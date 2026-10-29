// Public list of plans for the pricing section. A plan gets a Buy button once its Stripe Payment Link is set in Vercel
// as STRIPE_LINK_STARTER, STRIPE_LINK_PRO and STRIPE_LINK_TEAM. Until then the site shows "Request access".
const PLANS = require("../lib/plans");
module.exports = (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  const out = PLANS.map((p) => {
    const link = String(process.env["STRIPE_LINK_" + p.id.toUpperCase()] || "").trim();
    return { id: p.id, name: p.name, price: p.price, searches: p.searches, popular: !!p.popular, blurb: p.blurb, features: p.features, buy: /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//.test(link) ? link : "" };
  });
  res.status(200).json({ plans: out });
};
