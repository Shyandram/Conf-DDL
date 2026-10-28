#!/usr/bin/env python3
"""Write subscribable calendar feeds (.ics) from data/conferences.json.

The deploy workflow runs this, so the feeds change whenever the data does and calendar apps that
subscribe to them pick up new and corrected dates on their next refresh.

    calendar/all.ics             every entry
    calendar/area/<area>.ics     one per field (cv.ics, ml.ics, ...)
    calendar/series/<slug>.ics   one per series (cvpr.ics, ...): the site's starred list links these

Each entry gives events for its abstract and paper deadlines (timed, in UTC) and its rebuttal window
and decision (all-day). UIDs are stable, so an updated date moves the event instead of adding one.

Usage: python3 scripts/build_calendar.py [--site https://example.org/] [--out DIR]
"""
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "conferences.json"

# same table as tzOffset() in assets/app.js
TZ_OFFSETS = {"AOE": -12, "UTC": 0, "GMT": 0, "PST": -8, "PDT": -7, "EST": -5, "EDT": -4,
              "CET": 1, "CEST": 2, "JST": 9, "KST": 9, "CST": 8}


def tz_offset(tz):
    t = re.sub(r"\s", "", str(tz or "AoE")).upper()
    if t in TZ_OFFSETS:
        return TZ_OFFSETS[t]
    m = re.match(r"^(?:UTC|GMT)([+-]\d{1,2})(?::?(\d{2}))?$", t)
    if not m:
        raise ValueError(f"unknown timezone {tz!r}")
    h = int(m.group(1))
    return h + (1 if h >= 0 else -1) * int(m.group(2) or 0) / 60


def to_utc(s, tz):
    local = datetime.strptime(s, "%Y-%m-%d %H:%M")
    return (local - timedelta(hours=tz_offset(tz))).replace(tzinfo=timezone.utc)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def esc(s):
    return str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold(line):
    """RFC 5545: lines longer than 75 octets continue on the next line after a space."""
    out, cur = [], b""
    for ch in line:
        b = ch.encode("utf-8")
        if len(cur) + len(b) > (75 if not out else 74):
            out.append(cur.decode("utf-8"))
            cur = b""
        cur += b
    out.append(cur.decode("utf-8"))
    return "\r\n ".join(out)


def utc_stamp(dt):
    return dt.strftime("%Y%m%dT%H%M%SZ")


def day(s):
    return date.fromisoformat(s).strftime("%Y%m%d")


def next_day(s):
    return (date.fromisoformat(s) + timedelta(days=1)).strftime("%Y%m%d")


def events_of(c, site, stamp):
    est = c.get("status") != "confirmed"
    name = f"{c['title']} {c['year']}"
    tag = " (estimated)" if est else ""
    kind = c.get("kind")
    ddl_word = {"workshop": "workshop proposal deadline", "challenge": "submission deadline"}.get(kind, "paper deadline")
    dec_word = "results" if kind == "challenge" else "decision"
    desc = "\n".join(filter(None, [
        c.get("full_name"),
        f"Deadline: {c['deadline']} {c.get('timezone', 'AoE')}",
        c.get("abstract_deadline") and f"Abstract: {c['abstract_deadline']} {c.get('timezone', 'AoE')}",
        f"Conference: {c.get('date') or 'TBA'} · {c.get('place') or 'TBA'}",
        "Dates are estimated from last year's cycle." if est else "",
        c.get("note"),
        f"Countdown: {site}#c={c['id']}",
        f"Call for papers: {c['link']}",
    ]))
    common = [f"DTSTAMP:{stamp}", f"URL:{c['link']}", f"DESCRIPTION:{esc(desc)}"]
    if c.get("place"):
        common.append(f"LOCATION:{esc(c['place'])}")
    if est:
        common.append("STATUS:TENTATIVE")

    def timed(what, s, alarms):
        at = utc_stamp(to_utc(s, c.get("timezone")))
        ev = ["BEGIN:VEVENT", f"UID:{c['id']}-{slug(what)}@confddl", f"SUMMARY:{esc(f'{name} {what}{tag}')}",
              f"DTSTART:{at}", f"DTEND:{at}", *common]
        for trig, text in alarms:
            ev += ["BEGIN:VALARM", f"TRIGGER:{trig}", "ACTION:DISPLAY", f"DESCRIPTION:{esc(text)}", "END:VALARM"]
        return ev + ["END:VEVENT"]

    def allday(what, start, end):
        return ["BEGIN:VEVENT", f"UID:{c['id']}-{slug(what)}@confddl", f"SUMMARY:{esc(f'{name} {what}{tag}')}",
                f"DTSTART;VALUE=DATE:{day(start)}", f"DTEND;VALUE=DATE:{next_day(end)}", "TRANSP:TRANSPARENT",
                *common, "END:VEVENT"]

    out = []
    if c.get("abstract_deadline"):
        out += timed("abstract deadline", c["abstract_deadline"], [("-P1D", f"{name} abstract due tomorrow")])
    out += timed(ddl_word, c["deadline"], [("-P7D", f"{name} deadline in 7 days"), ("-P1D", f"{name} deadline tomorrow")])
    if isinstance(c.get("rebuttal"), list) and len(c["rebuttal"]) == 2:
        out += allday("rebuttal", c["rebuttal"][0], c["rebuttal"][1])
    if c.get("decision"):
        out += allday(dec_word, c["decision"], c["decision"])
    return out


def calendar(name, desc, confs, site, stamp):
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ConfDDL//Conference deadlines//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", f"X-WR-CALNAME:{esc(name)}", f"X-WR-CALDESC:{esc(desc)}", "X-WR-TIMEZONE:UTC",
             "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"]
    for c in sorted(confs, key=lambda c: to_utc(c["deadline"], c.get("timezone"))):
        lines += events_of(c, site, stamp)
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def main(argv):
    site = argv[argv.index("--site") + 1] if "--site" in argv else "https://conf-ddl.shyandram.dev/"
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else ROOT / "calendar"
    data = json.loads(DATA.read_text(encoding="utf-8"))
    confs, areas = data["conferences"], data.get("areas", {})
    stamp = utc_stamp(datetime.now(timezone.utc))
    files = {"all.ics": calendar("Conf DDL · all deadlines", "Conference deadlines, rebuttals and decisions from Conf DDL",
                                 confs, site, stamp)}
    for a, label in areas.items():
        sub = [c for c in confs if a in c.get("area", [])]
        if sub:
            files[f"area/{slug(a)}.ics"] = calendar(f"Conf DDL · {label}", f"{label} deadlines from Conf DDL", sub, site, stamp)
    series = {}
    for c in confs:
        series.setdefault(c.get("series") or c["title"], []).append(c)
    for s, sub in series.items():
        files[f"series/{slug(s)}.ics"] = calendar(f"{s} · Conf DDL", f"{s} deadlines from Conf DDL", sub, site, stamp)
    for rel, text in files.items():
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="")
    print(f"wrote {len(files)} calendars to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
