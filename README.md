# Conf DDL

Live countdowns to CV, ML, AI and NLP conference deadlines, including rebuttal and decision dates. **→ [conf-ddl.shyandram.dev](https://conf-ddl.shyandram.dev/)**

[![Code: MIT](https://img.shields.io/badge/code-MIT-555?style=flat-square)](LICENSE)
[![Data: CC BY 4.0](https://img.shields.io/badge/data-CC%20BY%204.0-555?style=flat-square)](data/LICENSE)

<p align="center">
  <img src="docs/desktop-light.jpg" alt="CVPR 2027 countdown over a photo of Seattle" width="68%">
  <img src="docs/phone.jpg" alt="Phone layout" width="22%">
</p>

## Features

- **Countdown** to the next deadline over a photo of the host city, then to its rebuttal and decision
- **Search and filters** by field, CCF-A, NYCU A, confirmed-only; a 12-month timeline
- **Planner** for where to resubmit after rebuttal or rejection
- **★ Star** a series to follow it every year; stars sync between devices
- **Calendar subscriptions** that update with the data (all, per field, per series, or your starred ones)
- **Share** a countdown with `#c=<id>` (e.g. `#c=cvpr27`)
- Local / AoE time, light and dark themes, works on phones

## Run locally

```bash
python3 -m http.server 8000   # open http://localhost:8000
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`).

## Add a conference

Ask Claude Code, e.g. *"add the ECCV 2028 deadline"*; it follows [`CLAUDE.md`](CLAUDE.md). You can also [open an issue](https://github.com/shyandram/conf-ddl/issues) with the call-for-papers link. To edit by hand, add an entry to `data/conferences.json`:

```json
{
  "id": "eccv28", "title": "ECCV", "year": 2028,
  "full_name": "European Conference on Computer Vision",
  "area": ["CV"], "link": "https://eccv.ecva.net/",
  "deadline": "2028-03-03 23:59", "timezone": "AoE", "status": "estimated",
  "place": "TBA", "rebuttal": ["2028-05-01", "2028-05-10"], "decision": "2028-06-15"
}
```

**Required:** `id`, `title`, `year`, `full_name`, `area`, `link`, `deadline` (`YYYY-MM-DD HH:MM`), `timezone` (`AoE`, `UTC+8`, `PDT`, …), `status` (`confirmed` or `estimated`).
**Optional:** `abstract_deadline`, `date`, `place` (`"City, Country"`, `"Japan (TBA)"`, `"TBA"`, `"Virtual"`), `rebuttal` (`[start, end]` or `false`), `decision`, `ccf`, `kind` (`workshop` / `workshop-paper` / `challenge`), `series`, `note`.

Then run `python3 scripts/validate.py`.

## Optional services

- **City photos:** add an `UNSPLASH_ACCESS_KEY` secret, then run *Actions → Refresh city photos*. It writes the photos to `data/cities.json`.
- **"My conferences" calendar and star sync:** a Cloudflare Worker. See [`worker/README.md`](worker/README.md).

## License

Both licenses require credit.

- **Code:** [MIT](LICENSE).
- **Conference data:** [CC BY 4.0](data/LICENSE). Credit it as *"Deadline data from [Conf DDL](https://github.com/shyandram/conf-ddl), CC BY 4.0"*.
- **City photos:** these belong to their photographers, under the [Unsplash License](https://unsplash.com/license).

Dates marked *estimated* are projections. Always check the official call for papers.
