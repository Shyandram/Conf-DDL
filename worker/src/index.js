// Calendar feed for "My conferences": merges the site's per-series feeds into one subscribable calendar.
//
//   GET /u/<id>.ics          the series this browser has starred (kept in KV, so the URL never changes)
//   PUT /u/<id>              {"series": ["cvpr", "iccv"]}: the site sends this whenever the stars change
//   GET /u/<id>              the same list back, so devices sharing an id keep the same stars
//   GET /my.ics?s=cvpr,iccv  a fixed list in the URL (no KV needed)
//
// The static site can't make a feed for every combination of starred series, so this Worker builds it on
// request from https://<site>/calendar/series/<slug>.ics (written on every deploy by scripts/build_calendar.py).
// Calendar apps re-fetch the same URL, so new or corrected dates, and newly starred series, reach them on their
// next refresh. An id is a random 22-character token made by the browser; it holds nothing but the star list.

const SLUG = /^[a-z0-9-]{1,40}$/;
const MAX_SERIES = 40;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, PUT, OPTIONS", "access-control-allow-headers": "content-type" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });

    const user = url.pathname.match(/^\/u\/([A-Za-z0-9_-]{16,64})(\.ics)?$/);
    if (user && method === "PUT" && !user[2]) {
      if (!env.STARS) return text("Star sync is not set up (no STARS KV binding)", 501);
      let slugs;
      try { slugs = (await request.json()).series; } catch { return text("Send JSON: {\"series\": [\"cvpr\", ...]}", 400); }
      if (!Array.isArray(slugs) || slugs.length > MAX_SERIES || !slugs.every(s => typeof s === "string" && SLUG.test(s)))
        return text(`series must be up to ${MAX_SERIES} slugs like "cvpr"`, 400);
      await env.STARS.put(user[1], JSON.stringify([...new Set(slugs)].sort()));
      return new Response(null, { status: 204, headers: CORS });
    }
    if (method !== "GET" && method !== "HEAD") return text("Method not allowed", 405);
    if (user && !user[2]) {
      if (!env.STARS) return text("Star sync is not set up (no STARS KV binding)", 501);
      const saved = await env.STARS.get(user[1]);
      return new Response(JSON.stringify({ series: saved ? JSON.parse(saved) : [], saved: saved !== null }), {
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    let slugs;
    if (user && user[2]) {
      if (!env.STARS) return text("Star sync is not set up (no STARS KV binding)", 501);
      try { slugs = JSON.parse((await env.STARS.get(user[1])) || "[]"); } catch { slugs = []; }
    } else if (url.pathname === "/my.ics") {
      slugs = [...new Set((url.searchParams.get("s") || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean))];
      if (!slugs.length || slugs.length > MAX_SERIES || !slugs.every(s => SLUG.test(s)))
        return text(`Give 1–${MAX_SERIES} series slugs, e.g. /my.ics?s=cvpr,iccv`, 400);
    } else {
      return text("Conf DDL calendar: GET /u/<id>.ics or /my.ics?s=cvpr,iccv", url.pathname === "/" ? 200 : 404);
    }

    const body = await merged(slugs, env);
    return new Response(method === "HEAD" ? null : body, {
      headers: {
        ...CORS,
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'inline; filename="my-conferences.ics"',
        // short, so a newly starred series shows up on the calendar app's next refresh
        "cache-control": user ? "private, max-age=300" : "public, max-age=1800",
      },
    });
  },
};

// One calendar from the series feeds. With no stars (or none found) it is still a valid, empty calendar,
// so a subscription doesn't break when everything is unstarred.
async function merged(slugs, env) {
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
  const names = parts.map(t => (t.match(/X-WR-CALNAME:([^\r\n]*)/) || [])[1]?.replace(/ · Conf DDL$/, "")).filter(Boolean);
  const desc = `X-WR-CALDESC:${fold((names.length ? names.join(", ") : "Nothing starred yet").replace(/[\\;,]/g, "\\$&") + " from Conf DDL")}`;
  const head = parts.length
    ? parts[0].slice(0, parts[0].indexOf("BEGIN:VEVENT"))
      .replace(/X-WR-CALNAME:[^\r\n]*(\r\n [^\r\n]*)*/, "X-WR-CALNAME:My conferences · Conf DDL")
      .replace(/X-WR-CALDESC:[^\r\n]*(\r\n [^\r\n]*)*/, desc)
    : ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ConfDDL//Conference deadlines//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:My conferences · Conf DDL", desc, "X-WR-TIMEZONE:UTC", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H", ""].join("\r\n");
  const events = parts.map(t => t.slice(t.indexOf("BEGIN:VEVENT"), t.lastIndexOf("END:VCALENDAR"))).join("");
  return head + events + "END:VCALENDAR\r\n";
}

function text(msg, status) {
  return new Response(msg + "\n", { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
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
