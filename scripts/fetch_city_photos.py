#!/usr/bin/env python3
"""Pick a few landscape city photos from Unsplash for every host city and save them to data/cities.json.
The page shows a random one of them each time, so the background changes between visits.

Needs an Unsplash access key in UNSPLASH_ACCESS_KEY (free developer account).
Cities that already have a photo keep it, so the page doesn't change on every run;
pass --refresh to pick again, or --refresh Tokyo Seattle to redo just those.
In data/cities.json, a city can carry "query" to steer the search, and "pin": true to never replace it.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFS = ROOT / "data" / "conferences.json"
CITIES = ROOT / "data" / "cities.json"
API = "https://api.unsplash.com"
UTM = "utm_source=conf_ddl&utm_medium=referral"
PHOTOS_PER_CITY = 4
MAX_PER_RUN = 9  # 1 search + 4 download pings per city; the demo tier allows 50 requests an hour

# Places that aren't a city name on their own (country-only keys search for the country's scenery).
QUERY_OVERRIDES = {
    "UK": "London skyline",
    "California": "San Francisco skyline",
    "Mexico / Central America": "Mexico City skyline",
    "Hong Kong": "Hong Kong skyline",
    "Singapore": "Singapore Marina Bay skyline",
    "Macau": "Macau skyline",
}


def city_of(place):
    """Photo key, same rule as venueOf() in assets/app.js: the city ("Seattle, USA" → Seattle), or the
    country when only that is known ("UK (TBA)" / "TBA, UK" → UK)."""
    if not place or place.strip().upper() == "TBA":
        return ""
    parts = [p.strip() for p in re.sub(r"\s*\((?:TBA|tentative)\)", "", place, flags=re.I).split(",") if p.strip()]
    if parts and parts[0].upper() == "TBA":
        parts = parts[1:]
    return ", ".join(parts[:-1]) if len(parts) > 1 else (parts[0] if parts else "")


def get(path, key, **params):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Client-ID {key}", "Accept-Version": "v1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# Only scenery: skylines, streets, landmarks, nature. Anything that mentions people, food, animals, vehicles
# up close or indoor shots is dropped (also from photos already saved, see clean()).
NOT_SCENERY = re.compile(
    r"\b(person|people|persons|woman|women|man|men|girl|girls|boy|boys|kid|kids|child|children|baby|crowd|couple|"
    r"family|friends|tourists?|pedestrians?|cyclists?|hikers?|portrait|selfie|face|hands?|wedding|bride|model|kimono|"
    r"food|coffee|drink|dish|meal|restaurant|cafe|bar|beer|wine|plate|"
    r"dog|dogs|cat|cats|horse|pet|"
    r"car|cars|bus|taxi|bike|motorcycle|interior|indoor|room|bedroom|office|desk|laptop|"
    r"text|sign|signage|poster|map|flag|logo)\b")


def is_scenery(text):
    return not NOT_SCENERY.search((text or "").lower())


def pick(results, n=PHOTOS_PER_CITY):
    """The n best wide, well-liked scenery photos."""
    def ok(p):
        tags = " ".join(t.get("title", "") for t in p.get("tags", []) or [])
        text = " ".join(filter(None, [p.get("description"), p.get("alt_description"), tags]))
        return p["width"] / p["height"] >= 1.3 and is_scenery(text)
    good = [p for p in results if ok(p)]
    return sorted(good, key=lambda p: (p.get("likes", 0), p["width"]), reverse=True)[:n]


def clean(cities):
    """Drop saved photos that aren't scenery; a city left with none gets searched again. Returns True if changed."""
    changed = False
    for city, entry in cities.items():
        photos = entry.get("photos", [])
        keep = [p for p in photos if is_scenery(p.get("alt"))]
        if len(keep) != len(photos):
            print(f"~ {city}: dropped {len(photos) - len(keep)} non-scenery photo(s)")
            entry["photos"] = keep
            changed = True
    return changed


def main(argv):
    cities = json.loads(CITIES.read_text(encoding="utf-8")) if CITIES.exists() else {}
    changed = clean(cities)
    key = os.environ.get("UNSPLASH_ACCESS_KEY", "").strip()
    if not key:
        print("UNSPLASH_ACCESS_KEY is not set; only cleaned the saved photos.")
        if changed:
            CITIES.write_text(json.dumps(dict(sorted(cities.items())), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return 0
    refresh_all = argv == ["--refresh"]
    refresh = set(argv[1:]) if argv[:1] == ["--refresh"] else set()

    confs = json.loads(CONFS.read_text(encoding="utf-8"))["conferences"]
    wanted = sorted({c for c in (city_of(x.get("place", "")) for x in confs) if c})

    done = 0
    for city in wanted:
        entry = cities.get(city, {})
        if entry.get("pin") or (entry.get("photos") and not refresh_all and city not in refresh):
            continue
        if done >= MAX_PER_RUN:
            print(f"… stopping at {MAX_PER_RUN} cities this run; the next run continues")
            break
        done += 1
        query = entry.get("query") or QUERY_OVERRIDES.get(city) or f"{city} cityscape landscape"
        try:
            res = get("/search/photos", key, query=query, orientation="landscape", per_page=15, content_filter="high")
        except Exception as e:  # rate limit or network: keep what we have
            print(f"! {city}: {e}")
            if getattr(e, "code", None) in (403, 429):
                print("… rate limited; the next run continues")
                break
            continue
        photos = pick(res.get("results", []))
        if not photos:
            print(f"- {city}: no result for {query!r}")
            continue
        for photo in photos:
            try:  # Unsplash asks apps to report when a photo is used
                get(urllib.parse.urlparse(photo["links"]["download_location"]).path, key)
            except Exception:
                pass
        cities[city] = {
            **({"query": entry["query"]} if entry.get("query") else {}),
            "photos": [{
                "src": p["urls"]["raw"] + "&w=1600&q=70&fit=max&auto=format",
                "color": p.get("color"),
                "alt": p.get("alt_description") or city,
                "photographer": p["user"]["name"],
                "photographer_url": f"{p['user']['links']['html']}?{UTM}",
                "photo_url": f"{p['links']['html']}?{UTM}",
            } for p in photos],
        }
        changed = True
        print(f"+ {city}: {len(photos)} photos ({query})")
        time.sleep(1.5)  # the demo tier allows 50 requests an hour

    if changed:
        CITIES.write_text(json.dumps(dict(sorted(cities.items())), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(wanted)} cities, {sum(1 for c in wanted if cities.get(c, {}).get('photos'))} with a photo set")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
