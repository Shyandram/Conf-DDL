#!/usr/bin/env python3
"""Sanity-check data/conferences.json before it ships. Usage: validate.py [path/to/conferences.json]"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DATA = Path(__file__).resolve().parent.parent / "data" / "conferences.json"
REQUIRED = ("id", "title", "year", "full_name", "area", "link", "deadline", "timezone", "status")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$")
# Abbreviations that name one half of a daylight-saving pair: the label has to match the season of the date,
# because the page reads them as fixed offsets (PST = UTC-8 even in July). (CST here is China, UTC+8.)
DST_PAIRS = {
    "PST": ("PDT", "America/Los_Angeles"), "PDT": ("PST", "America/Los_Angeles"),
    "EST": ("EDT", "America/New_York"), "EDT": ("EST", "America/New_York"),
    "CET": ("CEST", "Europe/Berlin"), "CEST": ("CET", "Europe/Berlin"),
}
SUMMER = {"PDT", "EDT", "CEST"}
TZ = re.compile(r"^(AoE|UTC|GMT|PST|PDT|EST|EDT|CET|CEST|JST|KST|CST|(UTC|GMT)[+-]\d{1,2}(:?\d{2})?)$", re.I)


def dst_mismatch(when, tz):
    """For a PST/PDT-style label, the label the date really needs, or None if it is right."""
    tz = (tz or "").upper()
    if tz not in DST_PAIRS:
        return None
    other, zone = DST_PAIRS[tz]
    local = datetime.strptime(when[:16], "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(zone))
    summer = bool(local.dst())
    return None if summer == (tz in SUMMER) else other


def main(path=DATA) -> int:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    areas = set(data.get("areas", {}))
    errors, seen = [], set()
    for i, c in enumerate(data["conferences"]):
        where = c.get("id", f"#{i}")
        for key in REQUIRED:
            if key not in c or c[key] in ("", None, []):
                errors.append(f"{where}: missing '{key}'")
        if c.get("id") in seen:
            errors.append(f"{where}: duplicate id")
        seen.add(c.get("id"))
        for key in ("deadline", "abstract_deadline"):
            if c.get(key) and not DATE.match(c[key]):
                errors.append(f"{where}: bad {key} '{c[key]}' (want YYYY-MM-DD HH:MM)")
            elif c.get(key) and len(c[key]) >= 16 and (fix := dst_mismatch(c[key], c.get("timezone"))):
                errors.append(f"{where}: {key} {c[key]} falls in {fix}, not {c['timezone']} "
                              f"(daylight saving; the page reads {c['timezone']} as a fixed offset)")
        reb = c.get("rebuttal")
        if reb is not None and reb is not False:
            if not (isinstance(reb, list) and len(reb) == 2 and all(DATE.match(x) for x in reb)) or reb[0] > reb[1]:
                errors.append(f"{where}: rebuttal must be [\"YYYY-MM-DD\", \"YYYY-MM-DD\"] in order")
            elif reb[0][:10] < c.get("deadline", "")[:10]:
                errors.append(f"{where}: rebuttal starts before the paper deadline")
        dec = c.get("decision")
        if dec is not None:
            if not DATE.match(dec):
                errors.append(f"{where}: bad decision '{dec}' (want YYYY-MM-DD)")
            elif dec[:10] < (((reb or None) or [None, c.get("deadline", "")])[1] or "")[:10]:
                errors.append(f"{where}: decision comes before the rebuttal / deadline")
        if c.get("timezone") and not TZ.match(c["timezone"]):
            errors.append(f"{where}: unknown timezone '{c['timezone']}'")
        if c.get("status") not in ("confirmed", "estimated"):
            errors.append(f"{where}: status must be 'confirmed' or 'estimated'")
        for a in c.get("area", []):
            if a not in areas:
                errors.append(f"{where}: area '{a}' not declared in 'areas'")
    for e in errors:
        print("✗", e)
    print(f"{len(data['conferences'])} conferences, {len(errors)} problems")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:2]))
