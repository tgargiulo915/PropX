// Vercel serverless function (goes in the api folder).
// Needs env vars: RENTCAST_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
module.exports = async (req, res) => {
  const address = String(req.query.address || "").slice(0, 200).trim();
  if (!address) return res.status(400).json({ error: "Enter an address." });
  const key = (process.env.RENTCAST_API_KEY || "").trim();
  if (!key) return res.status(500).json({ error: "Server is missing RENTCAST_API_KEY." });

  // Monthly cap so the free RentCast plan is never exceeded. Fails closed.
  const LIMIT = parseInt(process.env.MONTHLY_REQUEST_LIMIT || "45", 10); // RentCast requests per month
  const COST = 3; // requests used per address lookup
  const clean = (s) => String(s || "").trim().replace(/^[A-Za-z_]+\s*=\s*/, "").replace(/^["']+|["']+$/g, "").trim();
  let rUrl = clean(process.env.UPSTASH_REDIS_REST_URL);
  const rTok = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!rUrl || !rTok) return res.status(500).json({ error: "Usage counter isn't set up yet, so lookups are paused." });
  if (/^rediss?:\/\//i.test(rUrl)) return res.status(500).json({ error: "UPSTASH_REDIS_REST_URL is the wrong kind of address. Use the REST URL that starts with https://, not the one that starts with redis." });
  if (!/^https?:\/\//i.test(rUrl)) rUrl = "https://" + rUrl;
  let rBase;
  try { rBase = new URL(rUrl).origin; } catch (e) { return res.status(500).json({ error: "UPSTASH_REDIS_REST_URL isn't a valid web address. Paste only the address that starts with https://." }); }
  let why = "couldn't reach Upstash with that URL";
  try {
    const month = new Date().toISOString().slice(0, 7);
    const k = "propx:rentcast:" + month;
    const r = await fetch(rBase + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + rTok, "Content-Type": "application/json" },
      body: JSON.stringify([["INCRBY", k, COST], ["EXPIRE", k, 3000000]]),
    });
    why = "Upstash replied " + r.status + (r.status === 401 ? ", so the token looks wrong" : "");
    const out = await r.json();
    const used = Number(out && out[0] && out[0].result);
    if (!r.ok || !isFinite(used)) throw new Error("counter");
    if (used > LIMIT) return res.status(429).json({ error: "Free lookups are used up for this month. Enter your numbers manually below." });
  } catch (e) {
    return res.status(500).json({ error: "Usage counter is unavailable (" + why + "), so lookups are paused." });
  }

  const q = encodeURIComponent(address);
  const get = async (p) => {
    try {
      const r = await fetch("https://api.rentcast.io/v1" + p, { headers: { "X-Api-Key": key, Accept: "application/json" } });
      if (r.status === 429) return { __err: 429 };
      if (!r.ok) return { __err: r.status };
      return await r.json();
    } catch (e) { return { __err: "network" }; }
  };
  const [prop, val, rent] = await Promise.all([
    get("/properties?address=" + q),
    get("/avm/value?address=" + q + "&compCount=10&lookupSubjectAttributes=true"),
    get("/avm/rent/long-term?address=" + q + "&lookupSubjectAttributes=true"),
  ]);

  // Say the real reason when RentCast fails.
  const codes = [prop, val, rent].map((x) => (x && x.__err) || null);
  if (codes.every((c) => c)) {
    let e;
    if (codes.some((c) => c === 401 || c === 403)) e = "RentCast rejected the API key (code " + codes.find((c) => c === 401 || c === 403) + "). Check that the key in Vercel is current and that your RentCast plan is active.";
    else if (codes.some((c) => c === 429)) e = "RentCast request limit reached (code 429). Try again later.";
    else if (codes.every((c) => c === 404)) e = "No data found for that address. Include street, city, state and ZIP.";
    else e = "RentCast lookup failed (codes " + codes.join(", ") + "). Check your key and plan, then try again.";
    return res.status(502).json({ error: e });
  }

  const p = Array.isArray(prop) ? prop[0] : null;
  let tax = null;
  if (p && p.propertyTaxes) {
    const years = Object.keys(p.propertyTaxes).sort();
    const last = years.length ? p.propertyTaxes[years[years.length - 1]] : null;
    if (last && last.total) tax = last.total;
  }
  const comps = ((val && val.comparables) || []).slice(0, 6).map((c) => ({
    address: c.formattedAddress || "",
    details: [c.bedrooms != null ? c.bedrooms + "bd" : "", c.bathrooms != null ? c.bathrooms + "ba" : "", c.squareFootage ? c.squareFootage + " sf" : ""].filter(Boolean).join(" "),
    sold: String(c.removedDate || c.listedDate || "").slice(0, 7),
    price: c.price,
  }));
  const f = (p && p.features) || {};
  const sp = (val && val.subjectProperty) || {};
  const pick = (a, b) => (a !== undefined && a !== null ? a : b);
  const details = {
    type: pick(p && p.propertyType, sp.propertyType),
    beds: pick(p && p.bedrooms, sp.bedrooms),
    baths: pick(p && p.bathrooms, sp.bathrooms),
    sqft: pick(p && p.squareFootage, sp.squareFootage),
    lot: pick(p && p.lotSize, sp.lotSize),
    year: pick(p && p.yearBuilt, sp.yearBuilt),
    stories: f.floorCount,
    garage: f.garage, garageSpaces: f.garageSpaces,
    pool: f.pool, fireplace: f.fireplace,
    cooling: f.cooling, coolingType: f.coolingType,
    heating: f.heating, heatingType: f.heatingType,
    roof: f.roofType, exterior: f.exteriorType, foundation: f.foundationType,
    hoa: p && p.hoa && p.hoa.fee,
    county: pick(p && p.county, sp.county),
    zoning: p && p.zoning, subdivision: p && p.subdivision,
    lastSalePrice: p && p.lastSalePrice, lastSaleDate: p && p.lastSaleDate,
    ownerOccupied: p ? p.ownerOccupied : undefined,
    lat: pick(p && p.latitude, sp.latitude), lon: pick(p && p.longitude, sp.longitude),
  };
  // Cross-check the automated value against the comparable sales (price per sq ft).
  const psf = ((val && val.comparables) || []).filter((c) => c.price > 0 && c.squareFootage > 0).map((c) => c.price / c.squareFootage).sort((a, b) => a - b);
  const qt = (a, t) => { const i = (a.length - 1) * t, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
  let est = null;
  const sf = Number(details.sqft);
  if (psf.length >= 3 && sf > 0) {
    est = { n: psf.length, psf: Math.round(qt(psf, 0.5)), comp: Math.round(qt(psf, 0.5) * sf), low: Math.round(qt(psf, 0.25) * sf), high: Math.round(qt(psf, 0.75) * sf) };
  }
  // Renovated value: what the better comps sold for, never below the as-is value.
  const asIs = val && val.price;
  const arv = est ? Math.max(est.high, asIs || 0) : asIs;

  // Optional street-level photo (free Mapillary token in MAPILLARY_TOKEN). Skipped if not set.
  let photo = null;
  const mtok = (process.env.MAPILLARY_TOKEN || "").trim();
  const la = Number(details.lat), lo = Number(details.lon);
  if (mtok && la && lo) {
    try {
      const dy = 0.0007, dx = dy / Math.cos((la * Math.PI) / 180);
      const mr = await fetch("https://graph.mapillary.com/images?fields=id,thumb_1024_url,captured_at,compass_angle,geometry&limit=60&bbox=" + [lo - dx, la - dy, lo + dx, la + dy].join(",") + "&access_token=" + encodeURIComponent(mtok));
      if (mr.ok) {
        const mj = await mr.json();
        let best = null;
        (mj.data || []).forEach((im) => {
          if (!im.thumb_1024_url || !im.geometry || !im.geometry.coordinates) return;
          const [ix, iy] = im.geometry.coordinates;
          const my = (la - iy) * 111320, mx = (lo - ix) * 111320 * Math.cos((la * Math.PI) / 180);
          const dist = Math.hypot(mx, my);
          const bearing = ((Math.atan2(mx, my) * 180) / Math.PI + 360) % 360;
          const diff = Math.abs((((im.compass_angle || 0) - bearing + 540) % 360) - 180);
          if (diff > 50 || dist < 5) return;
          const score = diff + dist * 0.5 - (im.captured_at || 0) / 1e11;
          if (!best || score < best.score) best = { score, url: im.thumb_1024_url, at: im.captured_at };
        });
        if (best) photo = { url: best.url, date: best.at ? new Date(best.at).toISOString().slice(0, 7) : "" };
      }
    } catch (e) { /* photo is optional */ }
  }
  const notes = [];
  if (est && asIs && Math.abs(est.comp - asIs) / asIs > 0.1) notes.push("The automated value ($" + Math.round(asIs).toLocaleString("en-US") + ") and the comp-based value ($" + est.comp.toLocaleString("en-US") + ") differ by more than 10%. Check the comps and the home's condition before relying on either.");
  if (p) {
    if (p.yearBuilt) notes.push("Built in " + p.yearBuilt + ". Check roof, plumbing, electrical and HVAC age.");
    if (p.lastSalePrice && p.lastSaleDate) notes.push("Last sold for $" + Number(p.lastSalePrice).toLocaleString("en-US") + " on " + String(p.lastSaleDate).slice(0, 10) + ".");
    if (p.ownerOccupied === false) notes.push("Owner doesn't live there. Confirm who the seller is and if it is tenant-occupied.");
  }
  if (val && val.priceRangeLow && val.priceRangeHigh) notes.push("Value range from RentCast: $" + Math.round(val.priceRangeLow).toLocaleString("en-US") + " to $" + Math.round(val.priceRangeHigh).toLocaleString("en-US") + ". This is an as-is estimate, so confirm renovated value with your own comps.");
  if (!tax) notes.push("No tax amount found. Look it up with the county.");
  res.setHeader("Cache-Control", "s-maxage=3600");
  res.status(200).json({
    address: (p && p.formattedAddress) || (val && val.subjectProperty && val.subjectProperty.formattedAddress) || address,
    value: val && val.price, low: val && val.priceRangeLow, high: val && val.priceRangeHigh,
    arv, rent: rent && rent.rent, tax, comps, notes, details, est, photo,
  });
};
