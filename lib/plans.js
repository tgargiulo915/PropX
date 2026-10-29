// Plans sold on PropX. Edit prices and search counts here; the site, the pricing section and billing all read this file.
// A "search" is one address lookup. Each one uses 3 RentCast requests behind the scenes, so size plans to your RentCast quota.
module.exports = [
  { id: "starter", name: "Starter", price: 29, searches: 20, blurb: "For a new investor checking a few deals a month.",
    features: ["20 property searches a month", "Flip, rental, wholesale and BRRRR numbers", "Comps, rent and risk flags", "Share and print reports"] },
  { id: "pro", name: "Pro", price: 79, searches: 75, popular: true, blurb: "For active flippers and wholesalers.",
    features: ["75 property searches a month", "Everything in Starter", "Permit history where available", "Priority support"] },
  { id: "team", name: "Team", price: 199, searches: 250, blurb: "For small investment companies.",
    features: ["250 property searches a month", "Everything in Pro", "One shared key for your team", "Onboarding call"] },
];
