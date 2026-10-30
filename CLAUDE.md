# Conf DDL: notes for Claude

Static GitHub Pages site of conference deadline countdowns. All data lives in `data/conferences.json`; the page (`index.html`, `assets/app.js`, `assets/style.css`) reads it at runtime.

## When asked to search for / add / refresh a conference

1. Search the web for the **official** call for papers (the conference site, e.g. `cvpr.thecvf.com`, `neurips.cc`). Use third-party trackers only as a fallback.
2. Add or update the entry in `data/conferences.json` (schema in `README.md`):
   - `deadline` / `abstract_deadline` as `YYYY-MM-DD HH:MM` in the timezone the CFP states, with `timezone` set to match (`AoE` = UTC-12). PST/PDT, EST/EDT and CET/CEST must match the season of the date (validate.py checks this).
   - `status: "confirmed"` only when the date comes from the official site. If it is projected from last year's cycle, use `"estimated"` and say so in `note`.
   - `place` as `"City, Country"`; if only the country is known, `"Country (TBA)"` (e.g. `"Japan (TBA)"`) so it gets a country photo; `"TBA"` if unknown; `"Virtual"` for online-only editions.
   - `id` = lowercase short name + 2-digit year (`iccv27`); use a suffix for rounds (`wacv28r1`).
   - Also record the review timeline: `rebuttal` as `["YYYY-MM-DD", "YYYY-MM-DD"]` (or `false` if the venue has no rebuttal; omit if unannounced) and `decision` as `YYYY-MM-DD`. When the venue states the rebuttal's closing (or opening) time, write it as `YYYY-MM-DD HH:MM` in the `timezone` (or set `rebuttal_timezone` if it differs); the page then shows that exact moment.
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
  - the edits drift (shifted, scaled, or one tower moved): `scripts/align_scenes.py` (OpenCV) warps dawn, dusk and night onto the day picture, sky masked out by the depth map; the workflow runs it after the depth maps, and a rerun is a no-op;
  - redrawing keeps the previous set in `assets/scenes/<slug>/old-<date>/`, listed under `scenes_archive`.
  - **2.5D:** `scripts/gen_depth.py` (onnxruntime, Depth Anything V2 Small) writes `assets/scenes/<slug>/depth.webp` from the day picture, listed as `depth`; the scenes workflow runs it after drawing. With a depth map, `assets/scene3d.js` (loaded on demand, skipped for reduced motion or without WebGL) fades a WebGL canvas in over the picture: pixels move by depth with a slow camera drift and the mouse or phone tilt, and the four moods blend continuously by the reader's clock (`KEYS` there). `?hour=13.5` previews a time. Without a GPU (software WebGL) or when frames stall, the still picture stays; `?gl=force` draws anyway.
  - The page picks the mood from the reader's local clock (`localPhase` in `assets/app.js`: dawn 5–7, day 7–17, dusk 17–19, night), in step with the auto light / dark theme; the venue line still shows the venue's own sky (`sunAt` / `phaseAt`). Cities without scenes keep their Unsplash photos. Pictures are shown as they are, without colour grading.
- **Weather:** the page asks Open-Meteo (no key) for the venue's current weather every 15 minutes and draws rain, snow, fog or a storm on the `#wx` canvas over the backdrop. It shows the conditions and temperature in the venue line. `?weather=rain|snow|fog|storm` previews one.
- **City links:** `tourism` is the official visitor site; `famous` lists 3 sights, each with `url` = its own official site, or no `url` when none was verified. The owner wants official sites only (no Wikipedia or travel wikis); check every URL before adding it.
