#!/usr/bin/env python3
"""Write RSS feeds of date news from the history of data/conferences.json.

Each commit that changed the data is compared with the one before it. Every conference that was added,
confirmed, moved, or got its rebuttal, decision or venue announced becomes one item, dated by that commit.
The deploy workflow runs this (with the full git history checked out), so the feeds grow with the data.

    feed/all.xml             every change
    feed/area/<area>.xml     one per field (cv.xml, ml.xml, ...)
    feed/series/<slug>.xml   one per series (cvpr.xml, ...)

Usage: python3 scripts/build_feed.py [--site https://example.org/] [--out DIR] [--max N]
"""
import json
import subprocess
import sys
from datetime import date, datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_calendar import slug  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REL = "data/conferences.json"


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=True).stdout


def versions():
    """(commit, time, {id: entry}) for every commit that touched the data, oldest first."""
    out = []
    for line in git("log", "--reverse", "--format=%H %ct", "--", REL).splitlines():
        sha, ts = line.split()
        try:
            data = json.loads(git("show", f"{sha}:{REL}"))
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            continue
        out.append((sha, datetime.fromtimestamp(int(ts), timezone.utc), {c["id"]: c for c in data.get("conferences", [])}))
    return out


def when(s, tz=None):
    if not s:
        return "TBA"
    d = date.fromisoformat(s[:10])
    out = f"{d.strftime('%b')} {d.day}, {d.year}"
    return f"{out} {s[11:16]} {tz}" if len(s) > 10 and tz else out


def span(r):
    return f"{when(r[0])} – {when(r[1])}" if isinstance(r, list) else ("none" if r is False else "TBA")


def tba(p):
    return not p or "TBA" in p


def changes(old, c):
    """Headline and detail lines for what changed in one entry, or None."""
    tz = c.get("timezone", "AoE")
    est = c.get("status") != "confirmed"
    if old is None:
        return ("New" + (" (estimated)" if est else ""), [f"Deadline: {when(c['deadline'], tz)}"])
    lines, heads = [], []
    if old.get("status") != "confirmed" and not est:
        heads.append("Confirmed")
    for key, label in (("abstract_deadline", "Abstract"), ("deadline", "Deadline")):
        if old.get(key) != c.get(key) or old.get("timezone") != c.get("timezone"):
            if old.get(key) and c.get(key):
                lines.append(f"{label}: {when(old[key], old.get('timezone', 'AoE'))} → {when(c[key], tz)}")
                if key == "deadline":
                    heads.append("Deadline moved")
            elif c.get(key):
                lines.append(f"{label}: {when(c[key], tz)}")
    if old.get("rebuttal") != c.get("rebuttal") and "rebuttal" in c:
        lines.append(f"Rebuttal: {span(c['rebuttal'])}")
        if "rebuttal" not in old:
            heads.append("Rebuttal announced")
    if old.get("decision") != c.get("decision") and c.get("decision"):
        lines.append(f"Decision: {when(c['decision'])}" + (f" (was {when(old['decision'])})" if old.get("decision") else ""))
        if not old.get("decision"):
            heads.append("Decision date announced")
    if old.get("place") != c.get("place") and not tba(c.get("place")):
        lines.append(f"Venue: {c['place']}")
        if tba(old.get("place")):
            heads.append("Venue announced")
    if not lines and not heads:
        return None
    if heads and "Confirmed" in heads and not any(l.startswith("Deadline") for l in lines):
        lines.insert(0, f"Deadline: {when(c['deadline'], tz)}")
    return (", ".join(heads) or " and ".join(dict.fromkeys(l.split(":")[0] for l in lines)) + " updated", lines)


def news():
    items, prev = [], {}
    for sha, at, cur in versions():
        for cid, c in cur.items():
            ch = changes(prev.get(cid), c)
            if ch:
                items.append({"sha": sha, "at": at, "c": c, "head": ch[0], "lines": ch[1]})
        prev = cur
    items.sort(key=lambda i: i["at"], reverse=True)
    return items


def rss(title, desc, link, self_url, items, site):
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">', "<channel>",
           f"<title>{escape(title)}</title>", f"<link>{escape(link)}</link>", f"<description>{escape(desc)}</description>",
           "<language>en</language>", "<ttl>360</ttl>",
           f'<atom:link href="{escape(self_url)}" rel="self" type="application/rss+xml"/>',
           f"<lastBuildDate>{format_datetime(items[0]['at'] if items else datetime.now(timezone.utc))}</lastBuildDate>"]
    for i in items:
        c = i["c"]
        name = f"{c['title']} {c['year']}"
        page = f"{site}#c={c['id']}"
        body = [*i["lines"], f"Conference: {c.get('date') or 'TBA'} · {c.get('place') or 'TBA'}"]
        if c.get("status") != "confirmed":
            body.append("Dates are estimated from last year's cycle.")
        if c.get("note"):
            body.append(c["note"])
        html = "".join(f"<p>{escape(l)}</p>" for l in body) + \
            f'<p><a href="{escape(page)}">Countdown</a> · <a href="{escape(c["link"])}">Call for papers</a></p>'
        out += ["<item>", f"<title>{escape(f'{name}: {i['head']}')}</title>", f"<link>{escape(page)}</link>",
                f'<guid isPermaLink="false">{c["id"]}-{i["sha"][:10]}</guid>',
                f"<pubDate>{format_datetime(i['at'])}</pubDate>",
                *[f"<category>{escape(a)}</category>" for a in c.get("area", [])],
                f"<description>{escape(html)}</description>", "</item>"]
    out += ["</channel>", "</rss>"]
    return "\n".join(out) + "\n"


def main(argv):
    site = argv[argv.index("--site") + 1] if "--site" in argv else "https://conf-ddl.shyandram.dev/"
    out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else ROOT / "feed"
    cap = int(argv[argv.index("--max") + 1]) if "--max" in argv else 100
    data = json.loads((ROOT / REL).read_text(encoding="utf-8"))
    items = news()
    url = lambda rel: f"{site}feed/{rel}"
    files = {"all.xml": rss("Conf DDL · deadline news", "New, confirmed and moved conference deadlines from Conf DDL",
                            site, url("all.xml"), items[:cap], site)}
    for a, label in data.get("areas", {}).items():
        rel = f"area/{slug(a)}.xml"
        files[rel] = rss(f"Conf DDL · {label}", f"{label} deadline news from Conf DDL", site, url(rel),
                         [i for i in items if a in i["c"].get("area", [])][:cap], site)
    series = {}
    for i in items:
        series.setdefault(i["c"].get("series") or i["c"]["title"], []).append(i)
    for s in {c.get("series") or c["title"] for c in data["conferences"]}:
        rel = f"series/{slug(s)}.xml"
        files[rel] = rss(f"{s} · Conf DDL", f"{s} deadline news from Conf DDL", site, url(rel), series.get(s, [])[:cap], site)
    for rel, text in files.items():
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    print(f"wrote {len(files)} feeds ({len(items)} news items) to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
