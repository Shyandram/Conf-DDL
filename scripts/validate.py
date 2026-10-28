#!/usr/bin/env python3
"""Sanity-check data/conferences.json before it ships."""
import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "conferences.json"
REQUIRED = ("id", "title", "year", "full_name", "area", "link", "deadline", "timezone", "status")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$")
TZ = re.compile(r"^(AoE|UTC|GMT|PST|PDT|EST|EDT|CET|CEST|JST|KST|CST|(UTC|GMT)[+-]\d{1,2}(:?\d{2})?)$", re.I)


def main() -> int:
    data = json.loads(DATA.read_text(encoding="utf-8"))
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
    sys.exit(main())
