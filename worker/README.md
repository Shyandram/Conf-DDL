# Calendar worker

Serves one subscribable calendar for a set of starred series:

    https://conf-ddl-calendar.<your-subdomain>.workers.dev/my.ics?s=cvpr,iccv,alpasim

The site's Calendar dialog builds this link from your starred conferences once the Worker's address is set
(step 4). The Worker merges the site's per-series feeds (`calendar/series/<slug>.ics`, rebuilt on every deploy),
so new and corrected dates reach subscribed calendars on their next refresh. Free plan: 100,000 requests a day.

## Set up (once)

1. **Cloudflare account**: sign up at <https://dash.cloudflare.com/sign-up> (free). Open *Workers & Pages* once so
   your `*.workers.dev` subdomain gets created, and copy your **Account ID** (right-hand column of that page).
2. **API token**: *My Profile → API Tokens → Create Token →* template **Edit Cloudflare Workers**, account = yours,
   then create it and copy the token.
3. **GitHub secrets**: in this repository, *Settings → Secrets and variables → Actions → New repository secret*:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Then run *Actions → Deploy calendar worker → Run workflow*
   (later changes under `worker/` deploy on push). The log ends with the Worker's URL.
4. **Point the site at it**: in `index.html`, put that URL in
   `<meta name="confddl-calendar-worker" content="https://conf-ddl-calendar.<subdomain>.workers.dev/">` and push.
   Until this is set, the dialog offers the merged calendar as a one-off download instead.

`SITE` in `wrangler.toml` is where the series feeds are read from. Only lowercase series slugs (`a-z0-9-`,
at most 40 of them) are accepted, and feeds are cached at the edge for 10 minutes.
