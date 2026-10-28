// Calendar feed for "My conferences": merges the site's per-series feeds into one subscribable calendar.
//
//   GET /my.ics?s=cvpr,iccv,alpasim
//
// The static site can't make a feed for every combination of starred series, so this Worker builds it on
// request from https://<site>/calendar/series/<slug>.ics (written on every deploy by scripts/build_calendar.py).
// Calendar apps re-fetch the same URL, so new or corrected dates on the site reach them on their next refresh.

const SLUG = /^[a-z0-9-]{1,40}$/;
const MAX_SERIES = 40;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
    if (url.pathname !== "/my.ics") return text("Conf DDL calendar: GET /my.ics?s=cvpr,iccv (series slugs)", url.pathname === "/" ? 200 : 404);

    const slugs = [...new Set((url.searchParams.get("s") || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean))];
    if (!slugs.length || slugs.length > MAX_SERIES || !slugs.every(s => SLUG.test(s)))
      return text(`Give 1–${MAX_SERIES} series slugs, e.g. /my.ics?s=cvpr,iccv`, 400);

    const site = (env.SITE || "https://conf-ddl.shyandram.dev/").replace(/\/?$/, "/");
    const feeds = await Promise.all(slugs.map(async slug => {
      try {
        // the edge caches each series feed for 10 minutes, so busy calendars don't hammer the site
        const res = await fetch(`${site}calendar/series/${slug}.ics`, { cf: { cacheTtl: 600, cacheEverything: true } });
        return res.ok ? await res.text() : "";
      } catch {
        return "";
      }
    }));
    const parts = feeds.filter(t => t.startsWith("BEGIN:VCALENDAR") && t.includes("BEGIN:VEVENT"));
    if (!parts.length) return text("None of these series has a calendar on the site", 404);

    const names = parts.map(t => (t.match(/X-WR-CALNAME:([^\r\n]*)/) || [])[1]?.replace(/ · Conf DDL$/, "")).filter(Boolean);
    const head = parts[0].slice(0, parts[0].indexOf("BEGIN:VEVENT"))
      .replace(/X-WR-CALNAME:[^\r\n]*(\r\n [^\r\n]*)*/, "X-WR-CALNAME:My conferences · Conf DDL")
      .replace(/X-WR-CALDESC:[^\r\n]*(\r\n [^\r\n]*)*/, `X-WR-CALDESC:${fold(names.join(", ").replace(/[\\;,]/g, "\\$&") + " from Conf DDL")}`);
    const events = parts.map(t => t.slice(t.indexOf("BEGIN:VEVENT"), t.lastIndexOf("END:VCALENDAR"))).join("");
    const body = head + events + "END:VCALENDAR\r\n";

    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="my-conferences.ics"',
        "cache-control": "public, max-age=1800",
        "access-control-allow-origin": "*",
      },
    });
  },
};

function text(msg, status) {
  return new Response(msg + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } });
}

// RFC 5545 line folding for the description (continues the "X-WR-CALDESC:" line, so the first chunk is shorter)
function fold(value) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "", limit = 75 - "X-WR-CALDESC:".length;
  for (const ch of value) {
    if (enc.encode(cur + ch).length > limit) { out.push(cur); cur = ""; limit = 74; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}
