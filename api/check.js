// Vercel serverless function (goes in the api folder).
// Needs env vars: RENTCAST_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (and ADMIN_SECRET for the admin page)
// ---- Permit history from free city open-data portals (public records) ----
const SUF = new Set(["ST", "AVE", "AV", "DR", "RD", "BLVD", "LN", "CT", "PL", "WAY", "TER", "TERR", "CIR", "PKWY", "HWY", "TRL", "LOOP", "PATH", "PT", "SQ", "ALY", "XING", "RUN", "ROW", "CV", "PASS"]);
const DIRS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"];
function parseStreet(addr) {
  const line = String(addr).split(",")[0].toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(\d+)\s+(.+)$/.exec(line);
  if (!m) return null;
  const toks = m[2].split(" ");
  const si = toks.findIndex((t, i) => i > 0 && SUF.has(t));
  const core = si >= 0 ? toks.slice(0, si) : toks;
  if (!core.length) return null;
  const dir = core.length > 1 && DIRS.includes(core[0]) ? core[0] : null;
  return { num: m[1], base: core.join(" "), dir, nodir: core.slice(dir ? 1 : 0).join(" ") };
}
const NOISE = /garage sale|administrative|\bsigns?\b|banner|special event|contractor change|right.?of.?way|\btree/i;
const TAGS = [
  ["Roof", /roof|re-?roof|shingle/i], ["HVAC", /hvac|a\/c|air.?cond|furnace|mechanical|heat pump/i],
  ["Electrical", /electric|panel|service upgrade|wiring/i], ["Plumbing", /plumb|re-?pipe|water heater|sewer|gas line|backflow/i],
  ["Remodel", /remodel|renovat|alter|repair|interior|kitchen|bath/i], ["Addition", /addition|new construction|new dwelling/i],
  ["Pool", /pool|\bspa\b/i], ["Foundation", /foundation|pier|slab|underpin/i], ["Windows/doors", /window|door/i],
  ["Solar", /solar|photovoltaic|\bpv\b/i], ["Demolition", /demo/i],
];
const jget = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(4500), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("permit " + r.status);
  return r.json();
};
const LA_COMM = new Set(["los angeles", "van nuys", "sherman oaks", "north hollywood", "studio city", "encino", "tarzana", "woodland hills", "canoga park", "reseda", "northridge", "chatsworth", "granada hills", "sylmar", "sun valley", "pacoima", "arleta", "panorama city", "north hills", "winnetka", "west hills", "porter ranch", "lake view terrace", "tujunga", "sunland", "hollywood", "venice", "playa del rey", "san pedro", "wilmington", "harbor city", "pacific palisades", "mar vista", "west los angeles", "valley village", "mission hills", "toluca lake", "los feliz", "silver lake", "echo park", "highland park", "eagle rock", "boyle heights", "watts"]);
function variants(a) {
  return a.dir ? [a.num + " " + a.base] : [a.num + " " + a.base].concat(DIRS.map((d) => a.num + " " + d + " " + a.base));
}
const likeAny = (field, a) => "(" + variants(a).map((v) => "upper(" + field + ") like '" + v + " %'").join(" OR ") + ")";
async function permitLookup(fullAddr) {
  try {
    const parts = String(fullAddr).split(",");
    const city = parts[1] ? parts[1].trim().toLowerCase() : "";
    const zm = /,\s*([A-Z]{2})\s+(\d{5})/.exec(fullAddr);
    const st = zm ? zm[1] : "", zip = zm ? zm[2] : "";
    const a = parseStreet(fullAddr);
    if (!a) return null;
    const q = (o) => new URLSearchParams(o).toString();
    let rows = [], name = "", range = "recent years";
    if (st === "TX" && city === "san antonio") {
      name = "San Antonio"; range = "2020 to present";
      const where = variants(a).map((v) => "\"ADDRESS\" ILIKE '" + v + " %' OR \"ADDRESS\" ILIKE '" + v + ",%'").join(" OR ");
      const rids = ["c21106f9-3ef5-4f3a-8604-f992b4db7512", "c22b1ef2-dcf8-4d77-be1a-ee3638092aab"];
      const out = await Promise.all(rids.map((rid) => jget("https://data.sanantonio.gov/api/3/action/datastore_search_sql?sql=" + encodeURIComponent("SELECT \"PERMIT TYPE\" AS t, \"WORK TYPE\" AS w, \"DATE ISSUED\" AS d, \"DECLARED VALUATION\" AS c FROM \"" + rid + "\" WHERE " + where + " ORDER BY \"DATE ISSUED\" DESC LIMIT 30")).catch(() => null)));
      out.forEach((j) => ((j && j.result && j.result.records) || []).forEach((r) => rows.push({ date: r.d, type: r.t, desc: r.w, cost: r.c, status: "Issued" })));
    } else if (st === "IL" && city === "chicago") {
      name = "Chicago";
      const where = "street_number='" + a.num + "' AND upper(street_name) like '" + a.nodir + " %'" + (a.dir ? " AND street_direction='" + a.dir + "'" : "") + " AND issue_date IS NOT NULL";
      const j = await jget("https://data.cityofchicago.org/resource/ydr8-5enu.json?" + q({ $where: where, $order: "issue_date DESC", $limit: "30" }));
      j.forEach((r) => rows.push({ date: r.issue_date, type: String(r.permit_type || "").replace(/^PERMIT\s*[–-]\s*/i, ""), desc: r.work_description || r.work_type, status: r.permit_status }));
    } else if (st === "TX" && city === "austin") {
      name = "Austin";
      const j = await jget("https://data.austintexas.gov/resource/3syk-w9eu.json?" + q({ $where: likeAny("permit_location", a) + " AND issue_date IS NOT NULL", $order: "issue_date DESC", $limit: "30" }));
      j.forEach((r) => rows.push({ date: r.issue_date, type: r.permit_type_desc, desc: (r.work_class ? r.work_class + ": " : "") + (r.description || ""), status: r.status_current }));
    } else if (st === "WA" && city === "seattle") {
      name = "Seattle";
      const j = await jget("https://data.seattle.gov/resource/76t5-zqzr.json?" + q({ $where: likeAny("originaladdress1", a) + " AND issueddate IS NOT NULL", $order: "issueddate DESC", $limit: "30" }));
      j.forEach((r) => rows.push({ date: r.issueddate, type: r.permittypedesc, desc: r.description, cost: r.estprojectcost, status: r.statuscurrent }));
    } else if (st === "CA" && LA_COMM.has(city) && zip) {
      name = "Los Angeles"; range = "2020 to present";
      const j = await jget("https://data.lacity.org/resource/pi9x-tg5x.json?" + q({ $where: likeAny("primary_address", a) + " AND zip_code='" + zip + "' AND issue_date IS NOT NULL", $order: "issue_date DESC", $limit: "30" }));
      j.forEach((r) => rows.push({ date: r.issue_date, type: [r.permit_type, r.permit_sub_type].filter(Boolean).join(" / "), desc: r.work_desc, cost: r.valuation, status: r.status_desc }));
      if (city !== "los angeles" && !j.length) return null;
    } else {
      return null;
    }
    const seen = new Set();
    const items = rows.map((r) => ({
      date: String(r.date || "").slice(0, 10),
      type: String(r.type || "Permit").replace(/\s+/g, " ").trim().slice(0, 80),
      desc: String(r.desc || "").replace(/\s+/g, " ").trim().slice(0, 180),
      cost: Number(r.cost) > 0 ? Math.round(Number(r.cost)) : null,
      status: String(r.status || "").slice(0, 40),
    })).filter((i) => i.date && !NOISE.test(i.type + " " + i.desc)).filter((i) => {
      const k = i.date + "|" + i.type + "|" + i.desc;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((x, y) => (x.date < y.date ? 1 : -1));
    items.forEach((i) => { i.tags = TAGS.filter((t) => t[1].test(i.type + " " + i.desc)).map((t) => t[0]); });
    return { city: name, range, total: items.length, items: items.slice(0, 12) };
  } catch (e) {
    return null;
  }
}

const clean = (s) => String(s || "").trim().replace(/^[A-Za-z_]+\s*=\s*/, "").replace(/^["']+|["']+$/g, "").trim();
function redisConf() {
  let u = clean(process.env.UPSTASH_REDIS_REST_URL);
  const t = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!u || !t) return { err: "Usage counter isn't set up yet, so searches are paused." };
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

module.exports = async (req, res) => {
  // Never cache: every search must be checked against the customer's plan.
  res.setHeader("Cache-Control", "private, no-store");
  const address = String(req.query.address || "").slice(0, 200).trim();
  if (!address) return res.status(400).json({ error: "Enter an address." });
  const key = (process.env.RENTCAST_API_KEY || "").trim();
  if (!key) return res.status(500).json({ error: "Server is missing RENTCAST_API_KEY." });

  // Each customer has their own access key and monthly search allowance.
  const ck = String(req.headers["x-access-key"] || "").trim();
  if (!/^px_[a-f0-9]{24}$/.test(ck)) return res.status(401).json({ error: "Enter your access key to run a search.", needKey: true });
  const conf = redisConf();
  if (conf.err) return res.status(500).json({ error: conf.err });
  const month = new Date().toISOString().slice(0, 7);
  const ukey = "propx:use:" + ck + ":" + month;
  const gkey = "propx:rentcast:" + month;
  const LIMIT = parseInt(process.env.MONTHLY_REQUEST_LIMIT || "45", 10); // our own RentCast requests per month
  const COST = 3; // RentCast requests used behind one customer search
  const unavailable = (e) => res.status(500).json({ error: "Usage counter is unavailable (" + (e && e.message ? e.message : "error") + "), so searches are paused." });
  let cust;
  try {
    const [raw] = await pipe(conf, [["GET", "propx:cust:" + ck]]);
    cust = raw ? JSON.parse(raw) : null;
  } catch (e) { return unavailable(e); }
  if (!cust) return res.status(401).json({ error: "That access key isn't valid. Check it and try again.", needKey: true });
  if (cust.active === false) return res.status(403).json({ error: "This access key is turned off. Contact support." });
  const limit = Number(cust.limit) || 0;
  let used;
  try {
    const out = await pipe(conf, [["INCRBY", ukey, 1], ["EXPIRE", ukey, 3000000]]);
    used = Number(out[0]);
  } catch (e) { return unavailable(e); }
  const refund = async () => { try { await pipe(conf, [["DECRBY", ukey, 1]]); } catch (e) { /* best effort */ } };
  if (used > limit) {
    await refund();
    return res.status(429).json({ error: "You've used all " + limit + " searches in your plan this month. Upgrade your plan or wait until next month.", used: limit, limit });
  }
  try {
    const out = await pipe(conf, [["INCRBY", gkey, COST], ["EXPIRE", gkey, 3000000]]);
    if (Number(out[0]) > LIMIT) {
      await pipe(conf, [["DECRBY", gkey, COST]]);
      await refund();
      return res.status(503).json({ error: "Search capacity for this month has been reached. Please contact support." });
    }
  } catch (e) { await refund(); return unavailable(e); }

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
    await refund();
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
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const asIs = val && val.price;

  // ---- Cross-check the automated value against size-adjusted comparable sales ----
  const subSf = Number(details.sqft), subBeds = Number(details.beds);
  const wq = (arr, t) => {
    const a = arr.slice().sort((x, y) => x.v - y.v);
    const tot = a.reduce((s, x) => s + x.w, 0);
    let acc = 0;
    for (const x of a) { acc += x.w; if (acc >= tot * t) return x.v; }
    return a[a.length - 1].v;
  };
  let est = null;
  const allC = ((val && val.comparables) || []).filter((c) => c.price > 0 && c.squareFootage > 0);
  if (subSf > 0 && allC.length >= 3) {
    let use = allC.filter((c) => Math.abs(c.squareFootage - subSf) / subSf <= 0.35 && (!subBeds || c.bedrooms == null || Math.abs(c.bedrooms - subBeds) <= 1));
    if (use.length < 3) use = allC;
    const rows = use.map((c) => ({
      v: 0.5 * c.price + 0.5 * (c.price / c.squareFootage) * subSf, // partial size adjustment
      w: Math.max(c.correlation || 0.5, 0.1) / (1 + (c.daysOld || 0) / 180) / (1 + (c.distance || 0.5)),
      psf: c.price / c.squareFootage,
    }));
    const med = wq(rows, 0.5), lo = wq(rows, 0.25), hi = wq(rows, 0.75);
    const spread = (hi - lo) / med;
    const gap = asIs ? Math.abs(med - asIs) / asIs : 0;
    let conf = "Low";
    if (rows.length >= 6 && spread < 0.15 && gap < 0.1) conf = "High";
    else if (rows.length >= 4 && spread < 0.25 && gap < 0.2) conf = "Medium";
    est = {
      n: rows.length, psf: Math.round(wq(rows.map((r) => ({ v: r.psf, w: r.w })), 0.5)),
      comp: Math.round(med), low: Math.round(lo), high: Math.round(hi),
      spread: Math.round(spread * 100), gap: Math.round(gap * 100), conf,
    };
  }
  const avg = (a, b) => (a && b ? Math.round((a + b) / 2) : a || b || null);
  const best = est ? avg(asIs, est.comp) : asIs;
  const bestLow = est ? avg(val && val.priceRangeLow, est.low) : val && val.priceRangeLow;
  const bestHigh = est ? avg(val && val.priceRangeHigh, est.high) : val && val.priceRangeHigh;
  // Renovated value: what the better comps sold for, never below the as-is value.
  const arv = est ? Math.max(est.high, best || 0) : asIs;

  // ---- Optional street-level photo (free Mapillary token in MAPILLARY_TOKEN) ----
  let photo = null;
  const mtok = (process.env.MAPILLARY_TOKEN || "").trim();
  const la = Number(details.lat), lo = Number(details.lon);
  if (mtok && la && lo) {
    try {
      const dy = 0.0007, dx = dy / Math.cos((la * Math.PI) / 180);
      const mr = await fetch("https://graph.mapillary.com/images?fields=id,thumb_1024_url,captured_at,compass_angle,geometry&limit=60&bbox=" + [lo - dx, la - dy, lo + dx, la + dy].join(",") + "&access_token=" + encodeURIComponent(mtok));
      if (mr.ok) {
        const mj = await mr.json();
        let bestImg = null;
        (mj.data || []).forEach((im) => {
          if (!im.thumb_1024_url || !im.geometry || !im.geometry.coordinates) return;
          const [ix, iy] = im.geometry.coordinates;
          const my = (la - iy) * 111320, mx = (lo - ix) * 111320 * Math.cos((la * Math.PI) / 180);
          const dist = Math.hypot(mx, my);
          const bearing = ((Math.atan2(mx, my) * 180) / Math.PI + 360) % 360;
          const diff = Math.abs((((im.compass_angle || 0) - bearing + 540) % 360) - 180);
          if (diff > 50 || dist < 5) return;
          const score = diff + dist * 0.5 - (im.captured_at || 0) / 1e11;
          if (!bestImg || score < bestImg.score) bestImg = { score, url: im.thumb_1024_url, at: im.captured_at };
        });
        if (bestImg) photo = { url: bestImg.url, date: bestImg.at ? new Date(bestImg.at).toISOString().slice(0, 7) : "" };
      }
    } catch (e) { /* photo is optional */ }
  }

  // ---- "Check before you buy": each item says the problem, why it matters, and how to check ----
  const fullAddr = (p && p.formattedAddress) || (val && val.subjectProperty && val.subjectProperty.formattedAddress) || address;
  const stM = /,\s*([A-Z]{2})\s+\d{5}/.exec(fullAddr);
  const where = (details.county ? details.county + " County " : "") + (stM ? stM[1] + " " : "");
  const gs = (t) => "https://www.google.com/search?q=" + encodeURIComponent(where + t);
  const permits = await permitLookup(fullAddr);
  const checks = [];
  const add = (level, title, problem, why, how, link, linkText) => checks.push({ level, title, problem, why, how, link, linkText });

  if (est) {
    add(est.conf === "High" ? "ok" : est.conf === "Medium" ? "warn" : "bad",
      "Value estimate: " + est.conf + " confidence",
      "RentCast's automated value is " + money(asIs) + " and the size-adjusted comp value is " + money(est.comp) + " (" + est.gap + "% apart). The " + est.n + " comps range " + money(est.low) + " to " + money(est.high) + " (spread " + est.spread + "%).",
      "Automated values can't see condition, upgrades or layout. A big gap or a wide spread means the data disagrees, so an offer built on one number could be wrong by tens of thousands.",
      "Pull 3 to 5 sold homes within half a mile from the last 6 months that match this home's condition, and compare them to this estimate.");
  } else if (asIs) {
    add("warn", "Value estimate: not cross-checked",
      "There were too few comparable sales with square footage to double-check the automated value of " + money(asIs) + ".",
      "A single automated number has no second opinion, and it can't see condition or upgrades.",
      "Pull recent sold comps yourself before relying on this value.");
  }

  const yr = Number(details.year);
  if (yr > 1800) {
    const age = new Date().getFullYear() - yr;
    const issues = [];
    if (yr < 1978) issues.push("lead-based paint (banned in homes built after 1978)");
    if (yr < 1981) issues.push("asbestos in flooring, ceiling texture or pipe wrap");
    if (yr >= 1965 && yr <= 1973) issues.push("aluminum branch wiring, a fire risk that some insurers won't cover");
    if (yr >= 1978 && yr <= 1995) issues.push("polybutylene water pipes, which are known to leak and fail");
    if (yr < 1960) issues.push("old galvanized or cast-iron plumbing and outdated electrical");
    if (yr < 1950) issues.push("possible knob-and-tube wiring");
    if (yr >= 1950 && yr <= 1990) issues.push("older electrical panel brands with known failures (Federal Pacific, Zinsco)");
    if (age >= 15 || issues.length) {
      add(age >= 40 ? "bad" : "warn", "Age of the home and its systems",
        "Built in " + yr + " (" + age + " years old)." + (issues.length ? " Homes from this era commonly have: " + issues.join("; ") + "." : "") + (age >= 15 ? " The roof, HVAC and water heater are likely at or near the end of their life. Rough US replacement costs: roof $8,000 to $20,000, HVAC $5,000 to $12,000, water heater $1,000 to $2,500." : ""),
        "These problems are expensive, can be safety or insurance issues, and are often hidden until an inspection. They change your repair budget and your profit.",
        "Order a full inspection with a sewer scope and an electrical review, ask for the seller disclosure, and get an insurance quote before you commit.");
    }
  }

  const ls = p && Number(p.lastSalePrice), lsd = p && p.lastSaleDate && new Date(p.lastSaleDate);
  if (ls > 0 && lsd && !isNaN(lsd) && best) {
    const ch = (best - ls) / ls, months = (Date.now() - lsd.getTime()) / 2629800000;
    add(months < 12 || ch > 0.5 || ch < -0.2 ? "warn" : "", "Sale history",
      "Last sold for " + money(ls) + " in " + lsd.getUTCFullYear() + ". Today's estimate is " + money(best) + " (" + (ch >= 0 ? "+" : "") + Math.round(ch * 100) + "%)." + (months < 12 ? " That sale was under a year ago." : ""),
      "A sale far below today's value can mean it sold as a distressed or foreclosure deal, or has been improved since. A very recent sale means someone may already have flipped it, so your margin could be thin.",
      "Read the deed and listing history, and see whether any price jump came from permitted renovations.");
  }

  if (p && p.ownerOccupied === false) {
    add("warn", "Owner doesn't live there",
      "Records show the owner's mailing address is somewhere else, so it may be a rental, vacant or held by an investor.",
      "A tenant in place can limit your access and timeline, and removing one can take weeks or months and cost money. A vacant home may have unseen damage.",
      "Confirm who the seller is, whether it is tenant-occupied, and the lease terms before you make an offer.");
  }

  if (details.hoa) {
    add("warn", "HOA fees and rules",
      "An HOA fee of " + money(details.hoa) + "/month (" + money(details.hoa * 12) + "/year) is on record. This is not included in the default expenses.",
      "HOA fees cut your cash flow. Unpaid dues can become a lien on the home, special assessments can be large, and some HOAs limit rentals.",
      "Ask for the HOA's dues statement, any special assessments, and the rental and renovation rules.");
  }

  if (details.pool) {
    add("warn", "Pool",
      "The records show a pool.",
      "Pools add repair risk (pump, liner, plaster can cost thousands), higher insurance and liability, and some buyers and insurers avoid them.",
      "Have the pool inspected separately, and ask your insurer what it adds to the premium.");
  }

  if (tax && best) {
    add("", "Property taxes may change after a sale",
      "Current taxes are " + money(tax) + "/year, which is " + (tax / best * 100).toFixed(2) + "% of the estimated value.",
      "Many counties reassess after a sale, so your bill can jump to match your purchase price. That reduces cash flow and profit.",
      "Ask the county assessor how reassessment works, and estimate taxes using the local rate.", gs("property tax assessor reassessment after sale"), "Search the county assessor");
  } else if (!tax) {
    add("warn", "Property taxes not found",
      "We couldn't find a tax amount for this address, so the taxes field is a placeholder.",
      "Taxes are one of the largest ongoing costs. A wrong number changes your cash flow and profit.",
      "Look up the actual tax bill with the county tax office.", gs("property tax lookup"), "Search the county tax office");
  }

  if (rent && rent.rent) {
    const rl = rent.rentRangeLow, rh = rent.rentRangeHigh;
    add("", "Rent estimate",
      "Estimated rent is " + money(rent.rent) + "/month" + (rl && rh ? " (range " + money(rl) + " to " + money(rh) + ")" : "") + ".",
      "Rent estimates don't see the home's condition or the local tenant market. The gap between the low and high end can swing your cash flow by hundreds a month.",
      "Check 3 active rental listings nearby for similar bed, bath and size.");
  }

  if (permits) {
    if (permits.items.length) {
      const top = permits.items[0];
      const tagSet = [...new Set(permits.items.flatMap((i) => i.tags))];
      add("", "Renovation and permit history (" + permits.city + " records)",
        permits.total + " permit" + (permits.total === 1 ? "" : "s") + " on record at this address (" + permits.range + "). Most recent: " + top.date + ", " + top.type + (top.desc ? " (" + top.desc.slice(0, 90) + ")" : "") + "." + (tagSet.length ? " Work types seen: " + tagSet.join(", ") + "." : ""),
        "Recent permitted work such as a roof, HVAC or remodel can mean the home is worth more than an as-is estimate and may need fewer repairs. Work with no permit, or an open permit that was never finished or inspected, can become your problem.",
        "Open the full list in the report, confirm each job was finished and passed inspection, and ask the seller for receipts and warranties.");
    } else {
      add("", "Renovation and permit history (" + permits.city + " records)",
        "No permits found at this address in " + permits.city + "'s open permit data (" + permits.range + ").",
        "No permits can mean no major work, work done without a permit, or work before the data starts. The estimate can't assume any renovations either way.",
        "Ask the seller for a list of improvements with receipts, and search the city permit portal.");
    }
  }

  add("bad", "Liens and title",
    "Not in our data. Unpaid property taxes, HOA dues, contractor liens, court judgments and code fines can attach to the home.",
    "Liens stay with the property, so the buyer can end up paying them, and they can block a clean sale or loan.",
    "Order a title search before you close, and check the county recorder and tax office records.", gs("recorder of deeds property records search"), "Search county records");

  add("warn", "Flood zone",
    "Not in our data.",
    "A home in a FEMA high-risk zone usually needs flood insurance, which can add thousands a year, and lenders require it. It also affects resale.",
    "Look the address up on the FEMA flood map and get an insurance quote.", "https://msc.fema.gov/portal/search?AddressQuery=" + encodeURIComponent(fullAddr), "Open FEMA flood map");

  add("warn", "Permits and zoning",
    (details.zoning ? "Zoning on record: " + details.zoning + ". " : "") + "Permit history is not in our data.",
    "Unpermitted additions or conversions can force a tear-out, fines or a blocked sale, and zoning limits rentals and added units.",
    "Check the city or county permit history and confirm the zoning allows your plan.", gs("building permit records search"), "Search permit records");

  const order = { bad: 0, warn: 1, "": 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);

  res.status(200).json({
    address: fullAddr,
    value: best, rcValue: asIs, low: bestLow, high: bestHigh,
    arv, rent: rent && rent.rent, tax, comps, checks, details, est, photo, permits, usage: { used, limit },
  });
};
