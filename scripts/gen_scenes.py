#!/usr/bin/env python3
"""Panoramic backdrops for every host city, in four moods (dawn, day, dusk, night), made with OpenAI image generation.

The page shows the mood that matches the venue's local time (assets/app.js, sunPhase). For each city this script:
  1. finds its latitude, longitude and time zone (Open-Meteo geocoding, no key) and saves them in data/cities.json;
  2. generates a daytime panorama, then edits that same picture into dawn, dusk and night, so all four share one view;
  3. checks each picture's brightness against its mood (a night that came out brighter than the day is retried once);
  4. saves them as WebP under assets/scenes/<slug>/<phase>.webp and records them under "scenes" in data/cities.json.

Needs OPENAI_API_KEY (a repository secret; see .github/workflows/scenes.yml). Without it, only step 1 runs.
  python3 scripts/gen_scenes.py                 # cities without scenes, up to --limit of them
  python3 scripts/gen_scenes.py Tokyo Seattle   # just these (redo them if they have scenes)
  options: --limit N (default 4), --quality low|medium|high (default medium), --model NAME (default gpt-image-2),
           --phases night,dusk (redo only these moods from the saved day picture)
In data/cities.json each city carries "scene_prompt": the view to draw (viewpoint and landmarks). Redrawing a city
keeps its previous set in assets/scenes/<slug>/old-<date>/ (listed under "scenes_archive"), so nothing is lost.
"""
import base64
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_city_photos import city_of  # same photo key as the page  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFS = ROOT / "data" / "conferences.json"
CITIES = ROOT / "data" / "cities.json"
OUT = ROOT / "assets" / "scenes"
API = "https://api.openai.com/v1"
GEO = "https://geocoding-api.open-meteo.com/v1/search"
PHASES = ("day", "dawn", "dusk", "night")
SIZE = (2560, 1024)  # 2.5 : 1, inside the API's 3 : 1 limit; multiples of 16
SAVE_W = 2400        # saved width; the page shows it soft under a veil, so a smaller file is enough

# Places that aren't one city: where to put the sun, and what to draw.
REGIONS = {
    "Europe": ("Paris", "a classic European old town by a river, church spires and tiled roofs"),
    "South America": ("São Paulo", "a South American coastal city between green mountains and the sea"),
    "UK": ("London", "London along the Thames with its landmarks"),
    "California": ("San Francisco", "the San Francisco Bay with the Golden Gate Bridge and the city's hills"),
    "Hawaii": ("Honolulu", "Honolulu and Waikiki beach below Diamond Head"),
    "Mexico / Central America": ("Mexico City", "Mexico City with its historic centre and mountains beyond"),
}

MOODS = {
    "dawn": "at dawn, just after sunrise: a low warm sun on the horizon, a soft pink, peach and pale blue sky, "
            "light morning haze, long gentle shadows, a few lights still on",
    "dusk": "at dusk, in the minutes after sunset: an orange and violet sky fading to deep blue, "
            "warm light on the clouds, street lights and windows starting to glow",
    "night": "at night: a deep navy sky, the city lit up, glowing windows, street lights, floodlit landmarks "
             "and their reflections, no daylight left",
}
# expected order of mean brightness; a mood that breaks it was not followed
BRIGHT_ORDER = ("night", "dusk", "dawn", "day")


def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def country_of(city, confs):
    for c in confs:
        if city_of(c.get("place", "")) == city:
            parts = [p.strip() for p in re.sub(r"\s*\((?:TBA|tentative)\)", "", c["place"], flags=re.I).split(",")]
            return parts[-1] if len(parts) > 1 else ""
    return ""


def geocode(city, country):
    name = REGIONS.get(city, (city,))[0]
    q = urllib.parse.urlencode({"name": name, "count": 100, "language": "en"})  # many towns share a name
    for i in range(3):
        try:
            with urllib.request.urlopen(f"{GEO}?{q}", timeout=30) as r:
                results = json.load(r).get("results") or []
            break
        except OSError:
            if i == 2:
                raise
            time.sleep(3)
    if not results:
        return None
    want = {"usa": "united states", "uk": "united kingdom"}.get((country or "").lower(), (country or "").lower())
    pick = next((x for x in results if want and want in (x.get("country") or "").lower()), None)
    pick = pick or max(results, key=lambda x: x.get("population") or 0)
    return {"lat": round(pick["latitude"], 4), "lon": round(pick["longitude"], 4), "tz": pick["timezone"]}


def subject(city, country, entry):
    if entry.get("scene_prompt"):
        return entry["scene_prompt"]
    if city in REGIONS:
        return REGIONS[city][1]
    return f"{city}, {country}" if country and country.lower() != city.lower() else city


def day_prompt(what, own_view=False):
    view = (f"A photorealistic ultra-wide panoramic photograph: {what}." if own_view else
            f"A photorealistic ultra-wide panoramic photograph of {what}: a recognisable, characteristic view of the place "
            "as a travel photographer would frame it, from a slightly elevated viewpoint.")
    return (
        f"{view} Clear late-morning daylight, "
        "natural colours, crisp detail across the whole width. The horizon sits in the lower half, the upper third is "
        "open sky, so text can sit over it. No people in close-up, no text, no signs in focus, no watermark, no border, "
        "no fisheye distortion."
    )


def edit_prompt(phase):
    return (
        f"The same photograph {MOODS[phase]}. Keep exactly the same viewpoint, framing, horizon, buildings, landmarks "
        "and landscape; change only the time of day and its light. Photorealistic, no text, no watermark."
    )


def _post_json(path, key, body):
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def _post_form(path, key, fields, files):
    boundary = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, (name, data, mime) in files.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                  f"Content-Type: {mime}\r\n\r\n".encode())
        out.write(data + b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(f"{API}{path}", data=out.getvalue(), method="POST",
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def _call(fn, *args, tries=3):
    for i in range(tries):
        try:
            res = fn(*args)
            return base64.b64decode(res["data"][0]["b64_json"])
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")[:400]
            print(f"  ! HTTP {e.code}: {msg}")
            if e.code in (400, 401, 403) or i == tries - 1:  # a bad request or key won't get better by waiting
                raise
        except Exception as e:  # network hiccup
            print(f"  ! {e}")
            if i == tries - 1:
                raise
        time.sleep(10 * (i + 1))


def generate(key, model, quality, prompt):
    body = {"model": model, "prompt": prompt, "size": f"{SIZE[0]}x{SIZE[1]}", "quality": quality, "n": 1,
            "output_format": "png"}
    return _call(_post_json, "/images/generations", key, body)


def edit(key, model, quality, png, prompt):
    fields = {"model": model, "prompt": prompt, "size": f"{SIZE[0]}x{SIZE[1]}", "quality": quality, "n": 1,
              "output_format": "png"}
    return _call(_post_form, "/images/edits", key, fields, {"image[]": ("day.png", png, "image/png")})


def brightness(img):
    """Mean luminance 0–255 of the picture (a small grey thumbnail is enough)."""
    from PIL import ImageStat
    return ImageStat.Stat(img.convert("L").resize((256, 102))).mean[0]


def save(png, path):
    from PIL import Image
    img = Image.open(io.BytesIO(png)).convert("RGB")
    if img.width > SAVE_W:
        img = img.resize((SAVE_W, round(img.height * SAVE_W / img.width)), Image.LANCZOS)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "WEBP", quality=72, method=6)
    return img


def archive(city, entry, folder, phases=PHASES):
    """Before a city (or some of its moods) is drawn again, move those pictures into old-<date>/ and list them under
    scenes_archive."""
    if not entry.get("scenes") or not any((folder / f"{p}.webp").exists() for p in phases):
        return
    dest = folder / f"old-{time.strftime('%Y%m%d-%H%M')}"
    dest.mkdir(parents=True, exist_ok=True)
    kept = {}
    for p in phases:
        if (folder / f"{p}.webp").exists():
            (folder / f"{p}.webp").rename(dest / f"{p}.webp")
            kept[p] = f"assets/scenes/{slug(city)}/{dest.name}/{p}.webp"
    entry.setdefault("scenes_archive", []).append(
        {"scenes": kept, "model": entry.get("scene_model"), "prompt": entry.get("scene_prompt_used")})
    if phases == PHASES:
        entry.pop("scenes", None)
    print(f"  kept the previous scenes in {dest.relative_to(ROOT)}")


def write(cities):
    CITIES.write_text(json.dumps(dict(sorted(cities.items())), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv):
    opts = {"--limit": "4", "--quality": "medium", "--model": os.environ.get("OPENAI_IMAGE_MODEL") or "gpt-image-2",
            "--phases": ""}
    names = []
    it = iter(argv)
    for a in it:
        if a in opts:
            opts[a] = next(it, "")
        elif a.strip():
            names.append(a.strip())
    limit, quality, model = int(opts["--limit"]), opts["--quality"], opts["--model"]
    only = [p for p in opts["--phases"].split(",") if p.strip()] or None

    cities = json.loads(CITIES.read_text(encoding="utf-8"))
    confs = json.loads(CONFS.read_text(encoding="utf-8"))["conferences"]
    wanted = sorted({c for c in (city_of(x.get("place", "")) for x in confs) if c})

    # 1. where each place is (cheap, keyless): needed by the page for the sun
    changed = False
    for city in wanted:
        entry = cities.setdefault(city, {})
        if "tz" in entry:
            continue
        try:
            geo = geocode(city, country_of(city, confs))
        except Exception as e:
            print(f"! geocode {city}: {e}")
            continue
        if geo:
            entry.update(geo)
            changed = True
            print(f"@ {city}: {geo['lat']}, {geo['lon']} {geo['tz']}")
        time.sleep(0.3)
    if changed:
        write(cities)

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        print("OPENAI_API_KEY is not set; only filled in places.")
        return 0

    # 2–4. the pictures
    todo = [c for c in (names or wanted) if c in cities and (names or not cities[c].get("scenes"))][:limit]
    if not todo:
        print("Every city has its scenes.")
    failed = 0
    for city in todo:
        entry, country = cities[city], country_of(city, confs)
        what = subject(city, country, entry)
        folder = OUT / slug(city)
        print(f"+ {city}: {what} ({model}, {quality})")
        try:
            if only and "day" not in only and (folder / "day.webp").exists():  # new moods from the saved day
                from PIL import Image
                buf = io.BytesIO()
                Image.open(folder / "day.webp").convert("RGB").save(buf, "PNG")
                day_png = buf.getvalue()
            else:
                day_png = generate(key, model, quality, day_prompt(what, bool(entry.get("scene_prompt"))))
                archive(city, entry, folder)  # only once the new picture is in hand
            if only:
                archive(city, entry, folder, [p for p in only if p != "day"] + (["day"] if "day" in only else []))
            lum = {}
            if not only or "day" in only:
                lum["day"] = brightness(save(day_png, folder / "day.webp"))
            for phase in ("dawn", "dusk", "night"):
                if only and phase not in only:
                    continue
                for attempt in range(2):
                    img = save(edit(key, model, quality, day_png, edit_prompt(phase)), folder / f"{phase}.webp")
                    lum[phase] = brightness(img)
                    # a night must come out darker than the day, a dawn or dusk not brighter than it
                    ref = lum.get("day")
                    if ref is None or lum[phase] < ref * (0.7 if phase == "night" else 1.02):
                        break
                    print(f"  ~ {phase} came out too bright ({lum[phase]:.0f} vs day {ref:.0f}); "
                          + ("trying again" if attempt == 0 else "keeping it"))
            print("  brightness " + ", ".join(f"{p} {lum[p]:.0f}" for p in BRIGHT_ORDER if p in lum))
        except Exception as e:
            failed += 1
            print(f"! {city}: {e}")
            if failed >= 2:
                print("… two cities failed; stopping this run")
                break
            continue
        # the content hash in the URL lets browsers and the service worker keep a picture until it is redone
        have = {p: f"assets/scenes/{slug(city)}/{p}.webp?v={hashlib.sha1((folder / f'{p}.webp').read_bytes()).hexdigest()[:8]}"
                for p in PHASES if (folder / f"{p}.webp").exists()}
        entry["scenes"] = have
        entry["scene_model"] = model
        entry["scene_prompt_used"] = what
        write(cities)
    left = sum(1 for c in wanted if c in cities and not cities[c].get("scenes"))
    print(f"{len(wanted)} places, {len(wanted) - left} with scenes, {left} to go")
    return 1 if failed and failed == len(todo) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
