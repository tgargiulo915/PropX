# PropX (real data version)

1. Create a free RentCast account and copy your API key: https://app.rentcast.io/app/api
2. Put this folder on GitHub, or install the Vercel CLI.
3. Go to vercel.com, click Add New > Project, and import it (free Hobby plan).
4. In Project Settings > Environment Variables add:  RENTCAST_API_KEY = your key
5. Deploy. Open the site, enter a full address (street, city, state, ZIP), click Check this property.

Notes
- Your key stays on the server (api/check.js). The browser never sees it.
- Fills renovated value (RentCast's as-is estimate), rent, property taxes, comps, notes. Purchase price, repairs and insurance are the user's inputs.
- Early access signup falls back to an email link on this host.
- Free tier has request limits. Results are cached 1 hour to save requests.
