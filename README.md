# Conf DDL

Live countdowns to the main conference deadlines in computer vision, ML, AI and NLP (CVPR, ICCV, ECCV, NeurIPS, ICML, ICLR, AAAI, ACL, EMNLP, NAACL, COLING, …).

- **Hero countdown** for the next deadline that matches your filters, with flip-style digits
- **12-month timeline** of upcoming deadlines (solid = confirmed, dashed = estimated)
- **Search** (`/` to focus) and area filters (CV, ML, AI, NLP, Graphics, …), Confirmed-only and CCF-A toggles
- **★ Star** a conference to follow the whole series (every year, including future editions): it's pinned in the collapsible **My conferences** sidebar (saved in your browser), drives the big countdown, and the **★ Starred** toggle filters the list to it
- **Mouse light** (bulb in the top bar, off by default): the cursor lights up nearby glass surfaces
- **Live clock** (local and AoE), **Local / AoE** deadline display, light and dark themes
- **.ics export** with 7-day and 1-day reminders
- **Next venues at a glance:** click a conference on the 12-month timeline and the deadlines you could move to light up: amber during its rebuttal, green after its decision
- **Planner** (top-bar button, or *Plan resubmission* in a row): a separate view with the ranked resubmission path, chainable hop by hop, shareable as `#plan=<id>`
- **Venue grades** from the NYCU CS top-conference list (`tiers` in the data): NYCU A / B badges, an *NYCU A* filter, and the ranking used by the planner
- **Review timeline** on every card: submit → rebuttal → decision; after submission closes, the card counts down to the rebuttal window and then the decision

Plain static site: `index.html`, `assets/`, and one data file, `data/conferences.json`. No build step.
Animations use GSAP (Flip + ScrollTrigger) from cdnjs, and the page respects `prefers-reduced-motion`.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly with `file://` won't work because the page fetches the JSON.)

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` validates the data and publishes the site on every push to `main`.

1. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or run the workflow from the Actions tab). The site goes live at `https://shyandram.github.io/Conf-DDL/`.

All paths in the page are relative, so it works both under `/Conf-DDL/` and at the root of a custom domain.

### Custom domain (later)

1. **Settings → Pages → Custom domain**: enter the domain (e.g. `deadlines.example.com`) and save.
   With the Actions deployment, this setting is what counts, so no `CNAME` file is needed in the repo.
2. At your DNS provider:
   - Subdomain (`deadlines.example.com`): a `CNAME` record pointing to `shyandram.github.io`.
   - Apex domain (`example.com`): `A` records to `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
     (and optionally `AAAA` records to `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`).
3. Once DNS resolves, tick **Enforce HTTPS**.
4. Optional but recommended: verify the domain under **GitHub account Settings → Pages** so nobody else can claim it.

## City photos (Unsplash)

The countdown's background is a photo of the host city. Photos come from Unsplash via
`scripts/fetch_city_photos.py`, which writes `data/cities.json` (photo URL plus photographer credit).
Only scenery is kept (no people, food, animals, vehicles or indoor shots); a place without photos yet shows none until the next run.

One-time setup:

1. Create a free app at <https://unsplash.com/oauth/applications> and copy its **Access Key**.
2. In this repo: **Settings → Secrets and variables → Actions → New repository secret**,
   name `UNSPLASH_ACCESS_KEY`, value = the key.
3. **Actions → Refresh city photos → Run workflow.**

The workflow also runs when `data/conferences.json` changes and every hour until every city has photos; it commits new photos and redeploys.
Each city gets four photos and the page shows a random one per visit. The free tier allows 50 requests an hour, so each run fills 9 cities.
(Apply for Unsplash production access to raise the limit and fill everything in one run.)
To swap a photo you don't like, run the workflow with `refresh` set to the city name (e.g. `Tokyo`), or `all`.
In `data/cities.json` you can also give a city a custom `"query"`, or `"pin": true` to keep its photo.

## Adding or updating a conference

Ask Claude Code in this repo, e.g. *"search for the ECCV 2028 deadline and add it"*. It follows `CLAUDE.md`.
To edit by hand, add an entry to `data/conferences.json`:

```json
{
  "id": "eccv28",
  "title": "ECCV",
  "year": 2028,
  "full_name": "European Conference on Computer Vision",
  "area": ["CV"],
  "ccf": "B",
  "link": "https://eccv.ecva.net/",
  "abstract_deadline": "2028-02-25 23:59",
  "deadline": "2028-03-03 23:59",
  "timezone": "AoE",
  "date": "Sep 2028",
  "place": "TBA",
  "status": "estimated",
  "rebuttal": ["2028-05-01", "2028-05-10"],
  "decision": "2028-06-15",
  "note": "Projected from ECCV 2026."
}
```

- `timezone`: `AoE`, `UTC`, `UTC+8`, `UTC-7`, `PST`, `PDT`, `CET`, …
- `place`: `"City, Country"`; `"Country (TBA)"` when only the country is announced (its photos are filed under the country); `"TBA"` when nothing is known
- `status`: `confirmed` (from the official CFP) or `estimated` (projected from the previous cycle)
- `rebuttal`: `[start, end]` dates, or `false` if the venue has no rebuttal. Leave it out while unannounced (shows TBA)
- `decision`: date of the final decision / notification
- Top-level `tiers`: `{ "name", "source", "A": [series…], "B": [series…] }`, the grade list behind the badges and planner ranking
- `kind`: `"workshop"` for a workshop-proposal entry (e.g. `cvpr27w`); shown with a tag; `"workshop-paper"` for a workshop that takes papers (e.g. `ntire27`)
- `series`: only needed when an edition's `title` differs from the rest of its series (e.g. `"IJCAI-ECAI"` → `"series": "IJCAI"`), so stars follow it
- `abstract_deadline`, `rebuttal`, `decision`, `ccf`, `series`, `kind`, `note` are optional

Then run `python3 scripts/validate.py`.
