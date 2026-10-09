// Vercel serverless function. Needs env var RENTCAST_API_KEY.
module.exports = async (req, res) => {
  const address = String(req.query.address || "").slice(0, 200).trim();
  if (!address) return res.status(400).json({ error: "Enter an address." });
  const key = process.env.RENTCAST_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing RENTCAST_API_KEY." });
  const q = encodeURIComponent(address);
  const get = async (p) => {
    try {
      const r = await fetch("https://api.rentcast.io/v1" + p, { headers: { "X-Api-Key": key, Accept: "application/json" } });
      if (r.status === 429) return { __err: "rate" };
      if (!r.ok) return { __err: r.status };
      return await r.json();
    } catch (e) { return { __err: "network" }; }
  };
  const [prop, val, rent] = await Promise.all([
    get("/properties?address=" + q),
    get("/avm/value?address=" + q + "&compCount=5&lookupSubjectAttributes=true"),
    get("/avm/rent/long-term?address=" + q + "&lookupSubjectAttributes=true"),
  ]);
  if ([prop, val, rent].every((x) => x && x.__err)) {
    const e = prop.__err === "rate" ? "Rate limit reached. Try again later." : "No data found for that address. Include street, city, state and ZIP.";
    return res.status(404).json({ error: e });
  }
  const p = Array.isArray(prop) ? prop[0] : null;
  let tax = null;
  if (p && p.propertyTaxes) {
    const years = Object.keys(p.propertyTaxes).sort();
    const last = years.length ? p.propertyTaxes[years[years.length - 1]] : null;
    if (last && last.total) tax = last.total;
  }
  const comps = ((val && val.comparables) || []).slice(0, 4).map((c) => ({
    address: c.formattedAddress || "",
    details: [c.bedrooms != null ? c.bedrooms + "bd" : "", c.bathrooms != null ? c.bathrooms + "ba" : "", c.squareFootage ? c.squareFootage + " sf" : ""].filter(Boolean).join(" "),
    sold: String(c.removedDate || c.listedDate || "").slice(0, 7),
    price: c.price,
  }));
  const notes = [];
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
    arv: val && val.price, rent: rent && rent.rent, tax, comps, notes,
  });
};
