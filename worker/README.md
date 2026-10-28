# Calendar worker

Serves "My conferences" as one subscribable calendar that follows your stars:

    https://conf-ddl-calendar.<your-subdomain>.workers.dev/u/<id>.ics   series kept in KV for this id
    https://conf-ddl-calendar.<your-subdomain>.workers.dev/my.ics?s=cvpr,iccv   a fixed list in the URL

`GET /u/<id>` returns the saved list as JSON: devices that open the same `#sync=<id>` link share one id, so
they keep the same stars (and the same calendar). When the Calendar dialog is opened, the browser makes a random id and sends its starred series (`PUT /u/<id>`),
and sends them again whenever a star changes, so the subscribed URL never changes. The Worker merges the site's
per-series feeds (`calendar/series/<slug>.ics`, rebuilt on every deploy), so new and corrected dates and newly
starred series reach subscribed calendars on their next refresh.

**Free plan limits** (no card on file means it can't be billed; past a limit, requests fail until the next day):
100,000 Worker requests a day; KV 100,000 reads and 1,000 writes a day. One calendar refresh is 1 request and
1 KV read; a write happens only when a star changes in a browser that has opened the Calendar dialog.

## Set up (once)

1. **Cloudflare account**: sign up at <https://dash.cloudflare.com/sign-up> (free). Open *Workers & Pages* once so
   your `*.workers.dev` subdomain gets created, and copy your **Account ID** (right-hand column of that page).
2. **API token**: *My Profile → API Tokens → Create Token →* template **Edit Cloudflare Workers**, account = yours,
   then create it and copy the token.
3. **GitHub secrets**: in this repository, *Settings → Secrets and variables → Actions → New repository secret*:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Then run *Actions → Deploy calendar worker → Run workflow*
   (later changes under `worker/` deploy on push). The first deploy also creates the KV namespace
   `conf-ddl-calendar-stars`. The log ends with the Worker's URL.
4. **Point the site at it**: in `index.html`, put that URL in
   `<meta name="confddl-calendar-worker" content="https://conf-ddl-calendar.<subdomain>.workers.dev/">` and push.
   Until this is set, the dialog offers the merged calendar as a one-off download instead.

`SITE` in `wrangler.toml` is where the series feeds are read from. Only lowercase series slugs (`a-z0-9-`,
at most 40 of them) are accepted, and feeds are cached at the edge for 10 minutes.
