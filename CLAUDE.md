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

## City scenes, local time and city links

- **Place data:** every place in `data/cities.json` has `lat`, `lon` and an IANA `tz` (filled by `scripts/gen_scenes.py` from Open-Meteo, no key). A new host city gets them on the next run of that script; run it without `OPENAI_API_KEY` to fill places only.
- **Scenes:** *Actions → Generate city scenes* (`.github/workflows/scenes.yml`) makes a 2.5:1 panorama per city with OpenAI image generation (`OPENAI_API_KEY` secret):
  - one day picture, then edits of it into dawn, dusk and night;
  - saved under `assets/scenes/<slug>/` and listed in `scenes`; each city's `scene_prompt` sets the view (viewpoint and landmarks);
  - redrawing keeps the previous set in `assets/scenes/<slug>/old-<date>/`, listed under `scenes_archive`.
  - The page picks the mood from the sun's height at the venue (`sunAt` / `phaseAt` in `assets/app.js`); cities without scenes keep their Unsplash photos, toned to the hour.
- **City links:** `tourism` is the official visitor site; `famous` lists 3 sights, each with `url` = its own official site, or no `url` when none was verified. The owner wants official sites only (no Wikipedia or travel wikis); check every URL before adding it.
