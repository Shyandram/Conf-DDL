# Conf DDL: notes for Claude

Static GitHub Pages site of conference deadline countdowns. All data lives in `data/conferences.json`; the page (`index.html`, `assets/app.js`, `assets/style.css`) reads it at runtime.

## When asked to search for / add / refresh a conference

1. Search the web for the **official** call for papers (the conference site, e.g. `cvpr.thecvf.com`, `neurips.cc`). Use third-party trackers only as a fallback.
2. Add or update the entry in `data/conferences.json` (schema in `README.md`):
   - `deadline` / `abstract_deadline` as `YYYY-MM-DD HH:MM` in the timezone the CFP states, with `timezone` set to match (`AoE` = UTC-12). PST/PDT, EST/EDT and CET/CEST must match the season of the date (validate.py checks this).
   - `status: "confirmed"` only when the date comes from the official site. If it is projected from last year's cycle, use `"estimated"` and say so in `note`.
   - `place` as `"City, Country"`; if only the country is known, `"Country (TBA)"` (e.g. `"Japan (TBA)"`) so it gets a country photo; `"TBA"` if unknown; `"Virtual"` for online-only editions.
   - `id` = lowercase short name + 2-digit year (`iccv27`); use a suffix for rounds (`wacv28r1`).
   - Also record the review timeline: `rebuttal` as `["YYYY-MM-DD", "YYYY-MM-DD"]` (or `false` if the venue has no rebuttal; omit if unannounced) and `decision` as `YYYY-MM-DD`.
   - When an estimated entry becomes official, update it in place and flip `status`.
   - Keep entries for passed deadlines: they appear in the "Passed" list.
   - Venue grades live in the top-level `tiers` (NYCU CS top-conference list, A / B by series title). Add a new series there only if the list includes it.
3. Bump the top-level `updated` date.
4. Run `python3 scripts/validate.py`, then commit and push.
5. Tell the user which dates are confirmed vs estimated, with source links.

## Next up: panoramic, time-of-day backdrops (not started)

Planned with the owner; images will come from OpenAI image generation instead of Unsplash.

- **Goal:** each host city gets a wide panorama in four moods: dawn, day, dusk, night. The page shows the one that matches the venue's local time right now and cross-fades when the phase changes.
- **Place data:** add `lat`, `lon` and an IANA `tz` to each city in `data/cities.json`. Open-Meteo geocoding needs no key.
- **Phase:** computed in the browser from the sun's position (sunrise and sunset from lat/lon):
  - dawn: about 40 min before sunrise to 1 h after;
  - dusk: about 1 h before sunset to 40 min after;
  - otherwise day or night.
- **Images:**
  - a script (new, or an extension of `scripts/fetch_city_photos.py`) and a manual workflow generate the panoramas, with an `OPENAI_API_KEY` repository secret (never in chat or code);
  - save them as compressed WebP in the repo, one per city and phase;
  - label them "AI-generated" where the Unsplash credit is today;
  - keep Unsplash photos as the fallback for a city or phase that has no image yet.
- **Display:**
  - wide screens show the whole panorama;
  - narrow screens pan it slowly, or follow the mouse;
  - no motion under `prefers-reduced-motion`;
  - the venue card can show local time and phase (e.g. "Marrakesh · 18:42 dusk").
