# Conf DDL

Live countdowns to the main conference deadlines in computer vision, ML and AI (CVPR, ICCV, ECCV, NeurIPS, ICML, ICLR, AAAI, …).

- **Hero countdown** for the next deadline that matches your filters, with flip-style digits
- **12-month timeline** of upcoming deadlines (solid = confirmed, dashed = estimated)
- **Search** (`/` to focus) and area filters (CV, ML, AI, NLP, Graphics, …), Confirmed-only and CCF-A toggles
- **Local / AoE** time display, light and dark themes
- **.ics export** with 7-day and 1-day reminders
- **Review timeline** on every card: submit → rebuttal → decision; after submission closes, the card counts down to the rebuttal window and then the decision

Plain static site: `index.html`, `assets/`, and one data file, `data/conferences.json`. No build step.
Animations use GSAP (Flip + ScrollTrigger) from cdnjs, and the page respects `prefers-reduced-motion`.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` directly with `file://` won't work because the page fetches the JSON.)

## Deploy

`.github/workflows/pages.yml` validates the data and publishes the site on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

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
- `status`: `confirmed` (from the official CFP) or `estimated` (projected from the previous cycle)
- `rebuttal`: `[start, end]` dates, or `false` if the venue has no rebuttal. Leave it out while unannounced (shows TBA)
- `decision`: date of the final decision / notification
- `abstract_deadline`, `rebuttal`, `decision`, `ccf`, `note` are optional

Then run `python3 scripts/validate.py`.
