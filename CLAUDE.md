# Conf DDL: notes for Claude

Static GitHub Pages site of conference deadline countdowns. All data lives in `data/conferences.json`; the page (`index.html`, `assets/app.js`, `assets/style.css`) reads it at runtime.

## When asked to search for / add / refresh a conference

1. Search the web for the **official** call for papers (the conference site, e.g. `cvpr.thecvf.com`, `neurips.cc`). Use third-party trackers only as a fallback.
2. Add or update the entry in `data/conferences.json` (schema in `README.md`):
   - `deadline` / `abstract_deadline` as `YYYY-MM-DD HH:MM` in the timezone the CFP states, with `timezone` set to match (`AoE` = UTC-12).
   - `status: "confirmed"` only when the date comes from the official site. If it is projected from last year's cycle, use `"estimated"` and say so in `note`.
   - `id` = lowercase short name + 2-digit year (`iccv27`); use a suffix for rounds (`wacv28r1`).
   - When an estimated entry becomes official, update it in place and flip `status`.
   - Keep entries for passed deadlines: they appear in the "Passed" list.
3. Bump the top-level `updated` date.
4. Run `python3 scripts/validate.py`, then commit and push.
5. Tell the user which dates are confirmed vs estimated, with source links.
