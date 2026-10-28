(() => {
  "use strict";

  const DAY = 864e5;
  const HOT_DAYS = 7;
  const WARN_DAYS = 30;
  const BAR_WINDOW = 180 * DAY; // the progress bar fills over the last 180 days
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = typeof window.gsap !== "undefined";
  if (hasGsap && window.Flip) gsap.registerPlugin(Flip);
  if (hasGsap && window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const store = {
    get(k, d) { try { const v = localStorage.getItem("confddl:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("confddl:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const state = {
    q: "",
    areas: new Set(store.get("areas", [])),
    onlyConfirmed: store.get("onlyConfirmed", false),
    ccfA: store.get("ccfA", false),
    gradeA: store.get("gradeA", false),
    onlyStarred: store.get("onlyStarred", false),
    heroMode: store.get("heroMode", "deadline"),
    starred: new Set(store.get("starred", [])),
    tz: store.get("tz", "local"),
  };

  let data = { conferences: [], areas: {} };
  let confs = [];
  let heroConf = null;
  let nextBoundary = Infinity;

  /* ---------- time ---------- */

  const TZ_OFFSETS = { AOE: -12, UTC: 0, GMT: 0, PST: -8, PDT: -7, EST: -5, EDT: -4, CET: 1, CEST: 2, JST: 9, KST: 9, CST: 8 };

  function tzOffset(tz) {
    const t = String(tz || "AoE").toUpperCase().replace(/\s/g, "");
    if (t in TZ_OFFSETS) return TZ_OFFSETS[t];
    const m = t.match(/^(?:UTC|GMT)([+-]\d{1,2})(?::?(\d{2}))?$/);
    if (m) return Number(m[1]) + Math.sign(Number(m[1]) || 1) * Number(m[2] || 0) / 60;
    console.warn("Unknown timezone", tz, "- assuming AoE");
    return -12;
  }

  function parseDeadline(str, tz) {
    if (!str) return null;
    const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    const [, y, mo, d, h = "23", mi = "59", s] = m;
    // "23:59" means the whole minute is still open.
    const sec = s != null ? Number(s) : (mi === "59" ? 59 : 0);
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, sec) - tzOffset(tz) * 36e5;
  }

  const fmtLocal = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const fmtAoE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Etc/GMT+12" });
  const fmtShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

  // Milestone dates are nominal calendar days, so format them without shifting time zones.
  const fmtDayUTC = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const fmtDayFull = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const dayUTC = str => { const [y, m, d] = String(str).slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const fmtDay = (str, full) => (full ? fmtDayFull : fmtDayUTC).format(dayUTC(str));
  const fmtRange = ([a, b], full) => {
    const sameMonth = a.slice(0, 7) === b.slice(0, 7);
    if (sameMonth && !full) return `${fmtDay(a)}–${Number(b.slice(8, 10))}`;
    return `${fmtDay(a)} – ${fmtDay(b, full)}`;
  };

  const fmtTime = ms => (state.tz === "aoe" ? fmtAoE.format(ms) + " AoE" : fmtLocal.format(ms));

  function split(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(t / 86400), h: Math.floor(t / 3600) % 24, m: Math.floor(t / 60) % 60, s: t % 60 };
  }
  const pad = n => String(n).padStart(2, "0");

  // Stars follow the conference series (all years of CVPR), not one edition.
  const seriesOf = c => c.series || c.title;
  const isStarred = c => state.starred.has(seriesOf(c));
  // Venue grade from the ranking list in data/conferences.json ("tiers": NYCU CS top-conference list).
  const gradeOf = c => {
    const t = data.tiers || {};
    return (t.A || []).includes(seriesOf(c)) ? "A" : (t.B || []).includes(seriesOf(c)) ? "B" : "";
  };
  const gradeTag = c => {
    const g = gradeOf(c);
    return g ? `<span class="tag tag-grade tag-grade-${g}" title="${esc((data.tiers && data.tiers.source) || "")}">${esc((data.tiers && data.tiers.name) || "")} ${g}</span>` : "";
  };

  /* ---------- helpers ---------- */

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function urgency(ms) {
    const d = ms / DAY;
    return d < HOT_DAYS ? "hot" : d < WARN_DAYS ? "warn" : "";
  }

  function matches(c) {
    if (state.onlyConfirmed && c.status !== "confirmed") return false;
    if (state.ccfA && c.ccf !== "A") return false;
    if (state.gradeA && gradeOf(c) !== "A") return false;
    if (state.onlyStarred && !isStarred(c)) return false;
    if (state.areas.size && !c.area.some(a => state.areas.has(a))) return false;
    if (state.q) {
      const hay = [c.title, c.year, c.full_name, c.place, c.date, c.note, ...c.area, ...c.area.map(a => data.areas[a] || "")].join(" ").toLowerCase();
      return state.q.split(/\s+/).every(w => hay.includes(w));
    }
    return true;
  }

  /* ---------- .ics ---------- */

  function icsFor(c) {
    const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ConfDDL//EN", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${c.id}-${c.ddl}@confddl`,
      `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(c.ddl)}`,
      `DTEND:${stamp(c.ddl)}`,
      `SUMMARY:${c.title} ${c.year} paper deadline`,
      `DESCRIPTION:${(c.full_name + (c.note ? " — " + c.note : "")).replace(/[,;]/g, "\\$&")}`,
      `URL:${c.link}`,
      "BEGIN:VALARM", "TRIGGER:-P7D", "ACTION:DISPLAY", `DESCRIPTION:${c.title} deadline in 7 days`, "END:VALARM",
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", `DESCRIPTION:${c.title} deadline tomorrow`, "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${c.id}.ics` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ---------- cards ---------- */

  function buildCard(c) {
    const el = $("#cardTpl").content.firstElementChild.cloneNode(true);
    el.dataset.id = c.id;
    $(".star", el).setAttribute("aria-pressed", isStarred(c));
    el.classList.toggle("is-est", c.status !== "confirmed");
    $(".c-name", el).textContent = c.title;
    $(".c-year", el).textContent = c.year;
    $(".c-full", el).textContent = c.full_name;
    $(".c-tags", el).innerHTML =
      gradeTag(c) +
      (c.ccf ? `<span class="tag tag-ccf">CCF-${esc(c.ccf)}</span>` : "") +
      c.area.map(a => `<span class="tag">${esc(a)}</span>`).join("") +
      (c.status !== "confirmed" ? `<span class="tag tag-est">estimated</span>` : "") +
      (c.kind === "workshop" ? `<span class="tag tag-ws">workshop proposals</span>` : "");
    $(".c-date", el).textContent = c.date || "TBA";
    $(".c-place", el).textContent = c.place || "TBA";
    $(".c-note", el).textContent = c.note || "";
    if (!c.note) $(".c-note", el).remove();
    if (!c.abs) $(".c-abs", el).remove();
    const steps = $$(".c-steps li", el);
    const setStep = (li, text, title) => {
      $("b", li).textContent = text;
      li.title = title || "";
      li.classList.toggle("na", text === "TBA" || text === "none");
    };
    setStep(steps[0], fmtDay(c.deadline), fmtDay(c.deadline, true));
    // "rebuttal": false means the venue has none; a missing field means not announced yet.
    setStep(steps[1], c.rebuttal ? fmtRange(c.rebuttal) : (c.rebuttal === false ? "none" : "TBA"), c.rebuttal ? fmtRange(c.rebuttal, true) : "");
    setStep(steps[2], c.decision ? fmtDay(c.decision) : "TBA", c.decision ? fmtDay(c.decision, true) : "");
    if (!c.decision || c.kind === "workshop") $(".c-plan", el).remove();
    const link = $(".c-link", el);
    link.href = c.link;
    $(".c-ics", el).addEventListener("click", () => icsFor(c));
    c.el = el;
    c.refs = {
      days: $(".c-days", el), unit: $(".c-unit", el), hms: $(".c-hms", el), bar: $(".bar i", el),
      ddl: $(".c-ddl", el), abs: $(".c-abs dd", el), steps,
    };
    return el;
  }

  function paintTimes() {
    for (const c of confs) {
      c.refs.ddl.textContent = fmtTime(c.ddl);
      if (c.refs.abs) c.refs.abs.textContent = fmtTime(c.abs);
    }
    if (heroPick) { heroPick.when = eventOf(heroPick.c, heroPick.mode, Date.now())?.when || heroPick.when; $("#heroWhen").textContent = heroPick.when; }
  }

  // Where a submitted paper is in review: what comes next and when.
  function reviewPhase(c, now) {
    if (c.reb && now < c.reb[0]) return { step: 1, label: "to rebuttal", at: c.reb[0] };
    if (c.reb && now < c.reb[1]) return { step: 1, label: "rebuttal closes", at: c.reb[1], open: true };
    if (c.dec && now < c.dec) return { step: 2, label: "to decision", at: c.dec };
    return { step: c.dec ? 3 : 1, label: null };
  }

  function paintSteps(c, now) {
    const phase = c.ddl > now ? { step: 0 } : reviewPhase(c, now);
    const key = phase.step + (phase.open ? "o" : "");
    if (c.stepKey === key) return phase;
    c.stepKey = key;
    c.refs.steps.forEach((li, i) => {
      li.classList.toggle("done", i < phase.step);
      li.classList.toggle("now", i === phase.step);
    });
    c.el.classList.toggle("in-review", c.ddl <= now && phase.label != null);
    c.el.classList.toggle("in-rebuttal", !!phase.open);
    return phase;
  }

  function tickCard(c, now) {
    const left = c.ddl - now;
    const r = c.refs;
    const phase = paintSteps(c, now);
    if (left <= 0 && phase.label) {
      const t = split(phase.at - now);
      r.days.textContent = t.d;
      r.unit.textContent = t.d === 1 ? "day" : "days";
      r.hms.textContent = `${phase.label} · ${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
      r.bar.style.width = "100%";
      return;
    }
    if (left <= 0) {
      const ago = Math.floor(-left / DAY);
      r.days.textContent = ago;
      r.unit.textContent = ago === 1 ? "day ago" : "days ago";
      r.hms.textContent = c.dec ? "decided" : "closed";
      r.bar.style.width = "100%";
      return;
    }
    const t = split(left);
    r.days.textContent = t.d;
    r.unit.textContent = t.d === 1 ? "day" : "days";
    r.hms.textContent = `${pad(t.h)}h ${pad(t.m)}m ${pad(t.s)}s`;
    const u = urgency(left);
    if (c.u !== u) {
      c.el.classList.remove("u-hot", "u-warn");
      if (u) c.el.classList.add("u-" + u);
      c.u = u;
    }
    if (!c.barShown) return;
    r.bar.style.width = (Math.min(1, Math.max(0, 1 - left / BAR_WINDOW)) * 100).toFixed(3) + "%";
  }

  /* ---------- hero clock ---------- */

  const clockUnits = Object.fromEntries($$(".digits").map(el => [el.dataset.unit, { el, val: null }]));

  function setDigits(unit, value) {
    const u = clockUnits[unit];
    const str = unit === "d" ? String(value).padStart(2, "0") : pad(value);
    if (u.val === str) return;
    if (!u.val || u.val.length !== str.length) {
      u.el.innerHTML = [...str].map(ch => `<div class="digit"><span>${ch}</span></div>`).join("");
      u.val = str;
      return;
    }
    const boxes = u.el.children;
    [...str].forEach((ch, i) => {
      if (u.val[i] === ch) return;
      const box = boxes[i];
      // Drop digits still flipping out from an earlier change; the last child is the one on show.
      [...box.children].slice(0, -1).forEach(el => { if (hasGsap) gsap.killTweensOf(el); el.remove(); });
      const old = box.lastElementChild;
      const neu = document.createElement("span");
      neu.textContent = ch;
      box.appendChild(neu);
      if (hasGsap && !reduced) {
        gsap.fromTo(neu, { yPercent: -100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.5, ease: "expo.out" });
        gsap.to(old, { yPercent: 100, opacity: 0, duration: 0.5, ease: "expo.out", onComplete: () => old.remove() });
      } else {
        old.remove();
      }
    });
    u.val = str;
  }

  function splitChars(el, text) {
    el.innerHTML = [...text].map(ch => `<span class="ch">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
    return $$(".ch", el);
  }

  // Three candidates for the big countdown: next paper deadline, next rebuttal event, next decision.
  // Each comes from the starred series first, then the filtered list, then everything.
  // The chip row under the clock shows all three; the chosen one (state.heroMode) drives the big clock.
  const MODES = ["deadline", "rebuttal", "decision"];

  function eventOf(c, mode, now) {
    if (mode === "deadline") return c.ddl > now ? { at: c.ddl, kind: "Next deadline", when: fmtTime(c.ddl) } : null;
    if (mode === "rebuttal") {
      if (!c.reb || now >= c.reb[1]) return null;
      const opens = now < c.reb[0];
      return { at: opens ? c.reb[0] : c.reb[1], kind: opens ? "Rebuttal opens" : "Rebuttal closes",
        when: "Rebuttal " + fmtRange(c.rebuttal, true) };
    }
    return c.dec && c.dec > now ? { at: c.dec, kind: "Next decision", when: "Decision " + fmtDay(c.decision, true) } : null;
  }

  function pickFor(mode, now) {
    const filtered = state.areas.size || state.onlyConfirmed || state.ccfA || state.gradeA || state.q || state.onlyStarred;
    const pools = [
      [confs.filter(isStarred), "My conferences"],
      [confs.filter(c => c.el.style.display !== "none"), filtered ? "your filters" : ""],
      [confs, ""],
    ];
    for (const [pool, scope] of pools) {
      let best = null;
      for (const c of pool) {
        const ev = eventOf(c, mode, now);
        if (ev && (!best || ev.at < best.at)) best = { ...ev, c, mode, scope };
      }
      if (best) return best;
    }
    return null;
  }

  let picks = {};
  let heroPick = null;

  function refreshPicks(now) {
    picks = Object.fromEntries(MODES.map(m => [m, pickFor(m, now)]));
    let mode = picks[state.heroMode] ? state.heroMode : "deadline";
    let p = picks[mode];
    // a conference clicked on the timeline takes the big clock until a chip is clicked
    if (state.manualId) {
      const c = confs.find(x => x.id === state.manualId);
      const ev = c && MODES.map(m => eventOf(c, m, now)).find(Boolean);
      if (ev) { p = { ...ev, c, mode: "manual", scope: "from timeline" }; mode = "manual"; }
      else state.manualId = null;
    }
    const key = p ? `${mode}:${p.c.id}:${p.at}` : "";
    if (key !== (heroPick && heroPick.key)) {
      heroPick = p ? { ...p, key } : null;
      $("#heroScope").textContent = p ? p.scope : "";
      $("#heroKind").textContent = p ? p.kind : "Next deadline";
      Object.values(clockUnits).forEach(u => { u.val = null; }); // new target: redraw digits instead of flipping
      setHero(p ? p.c : null);
      if (p) $("#heroWhen").textContent = p.when;
      $("#heroIcs").hidden = !p || p.at !== p.c.ddl;
    }
    for (const btn of $$("#heroPicks .pick")) {
      const q = picks[btn.dataset.mode];
      btn.hidden = !q;
      btn.setAttribute("aria-pressed", !!q && btn.dataset.mode === mode);
      if (!q) continue;
      $(".p-name", btn).textContent = `${q.c.title} ${String(q.c.year).slice(2)}`;
      const t = split(q.at - now);
      $(".p-left", btn).textContent = t.d ? `${t.d}d ${pad(t.h)}h` : `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
      btn.title = `${q.kind}: ${q.c.title} ${q.c.year} · ${q.when}`;
    }
    tickHero(now);
  }

  // Host city card next to the clock, with a photo from Wikipedia when one exists.
  const COUNTRY_NAMES = { USA: "United States", UK: "United Kingdom" };
  const wikiCache = new Map();

  async function wikiImage(title) {
    if (wikiCache.has(title)) return wikiCache.get(title);
    const job = fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => (j && j.type !== "disambiguation" && (j.originalimage || j.thumbnail))
        ? { src: (j.thumbnail && j.thumbnail.source.replace(/\/\d+px-/, "/960px-")) || j.originalimage.source, page: j.content_urls?.desktop?.page }
        : null)
      .catch(() => null);
    wikiCache.set(title, job);
    return job;
  }

  // data/cities.json: hand-off from scripts/fetch_city_photos.py (Unsplash). Wikipedia is the fallback.
  let cityPhotos = {};
  const loadCityPhotos = fetch("data/cities.json", { cache: "no-cache" })
    .then(r => (r.ok ? r.json() : {})).then(j => { cityPhotos = j || {}; }).catch(() => {});

  // Several photos per city; show a different one each time (never the same twice in a row).
  const lastPhoto = {};
  function pickCityPhoto(city) {
    const entry = cityPhotos[city];
    const list = entry ? (entry.photos || (entry.src ? [entry] : [])) : [];
    if (!list.length) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === lastPhoto[city]) i = (i + 1) % list.length;
    lastPhoto[city] = i;
    return list[i];
  }

  async function setVenue(c) {
    const fig = $("#venue"), img = $("#venueImg"), credit = $("#venueCredit");
    img.classList.remove("is-loaded");
    credit.hidden = true;
    const place = c && c.place && !/^TBA$/i.test(c.place) ? c.place : "";
    const parts = place.replace(/\s*\((?:TBA|tentative)\)/i, "").split(",").map(x => x.trim()).filter(Boolean);
    const city = parts.length > 1 ? parts.slice(0, -1).join(", ") : parts[0] || "";
    const country = parts.length > 1 ? parts[parts.length - 1] : "";
    fig.classList.toggle("is-tba", !place);
    $("#venueCity").textContent = place ? city : "Venue to be announced";
    $("#venueCountry").textContent = country;
    $("#venueDates").textContent = c ? c.date || "" : "";
    if (!place) return;
    const token = (fig.dataset.token = String(Math.random()));
    await loadCityPhotos;
    const un = pickCityPhoto(city);
    const found = (un && { src: un.src, unsplash: un }) || (await wikiImage(city)) || (city.includes("/") && (await wikiImage(city.split("/")[0].trim())))
      || (country && (await wikiImage(COUNTRY_NAMES[country] || country)));
    if (!found || fig.dataset.token !== token) return;
    const pre = new Image();
    pre.onload = () => {
      if (fig.dataset.token !== token) return;
      img.style.backgroundImage = `url("${found.src}")`;
      img.classList.add("is-loaded");
      if (found.unsplash) {
        const u = found.unsplash;
        credit.innerHTML = `Photo by <a href="${esc(u.photographer_url)}" target="_blank" rel="noopener">${esc(u.photographer)}</a>` +
          ` on <a href="${esc(u.photo_url)}" target="_blank" rel="noopener">Unsplash</a>`;
        credit.hidden = false;
      } else if (found.page) {
        credit.innerHTML = `Photo: <a href="${esc(found.page)}" target="_blank" rel="noopener">Wikipedia</a>`;
        credit.hidden = false;
      }
    };
    pre.src = found.src;
  }

  function setHero(c) {
    if (c === heroConf) return;
    const first = heroConf === null;
    heroConf = c;
    setVenue(c);
    const hero = $("#hero");
    if (!c) {
      $("#heroName").textContent = "All clear";
      $("#heroYear").textContent = "";
      $("#heroFull").textContent = "No upcoming deadlines match your filters.";
      $("#heroWhen").textContent = "";
      $("#heroKind").textContent = "Next deadline";
      $("#heroPlace").textContent = "";
      hero.classList.add("is-empty");
      return;
    }
    hero.classList.remove("is-empty");
    const chars = splitChars($("#heroName"), c.title);
    $("#heroYear").textContent = c.year;
    $("#heroFull").textContent = c.full_name + (c.status !== "confirmed" ? " · estimated date" : "");
    $("#heroPlace").textContent = [c.place, c.date].filter(Boolean).join(" · ");
    $("#heroLink").href = c.link;
    if (hasGsap && !reduced) {
      gsap.fromTo(chars, { yPercent: 110 }, { yPercent: 0, duration: first ? 1.1 : 0.7, ease: "expo.out", stagger: 0.04, delay: first ? 0.15 : 0 });
      gsap.fromTo(["#heroYear", "#heroFull", ".hero-foot"], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.06, delay: first ? 0.4 : 0.1 });
    }
  }

  function tickHero(now) {
    const clock = $("#clock");
    const left = heroPick ? heroPick.at - now : 0;
    const t = split(left);
    setDigits("d", t.d); setDigits("h", t.h); setDigits("m", t.m); setDigits("s", t.s);
    const u = heroPick && heroPick.mode === "deadline" ? urgency(left) : "";
    clock.classList.toggle("is-hot", u === "hot");
    clock.classList.toggle("is-warn", u === "warn");
    if (heroPick) document.title = `${t.d}d ${pad(t.h)}:${pad(t.m)} · ${heroPick.c.title} ${heroPick.c.year} — Conf Deadlines`;
  }

  /* ---------- timeline ---------- */

  let timelineList = [];

  // Home timeline by default; the planner passes its own element and asks for the resubmission path.
  function renderTimeline(list, now, opts = {}) {
    const tl = opts.el || $("#timeline");
    if (!opts.el) timelineList = list;
    const start = new Date(now); start.setDate(1); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setMonth(end.getMonth() + 13);
    const span = end - start;
    const x = ms => ((ms - start) / span) * 100;

    let html = `<div class="timeline-inner"><div class="tl-axis"></div>`;
    for (let i = 0; i < 13; i++) {
      if (i === 12) break; // the 13th tick would sit on the right edge and overflow
      const m = new Date(start); m.setMonth(m.getMonth() + i);
      const label = m.toLocaleString(undefined, { month: "short" }) + (m.getMonth() === 0 ? ` ’${String(m.getFullYear()).slice(2)}` : "");
      html += `<span class="tl-month" style="left:${x(+m)}%">${esc(label)}</span>`;
    }
    html += `<div class="tl-today" style="left:${x(now)}%"></div>`;

    // Labels hang to the right of their pin; stack them on rows so none overlap.
    const W = Math.max(tl.clientWidth, 720);
    const rowEnd = [];
    const pins = list.filter(c => c.ddl > now && c.ddl < +end).map(c => {
      const px = x(c.ddl);
      const label = `${c.title} ${String(c.year).slice(2)}`;
      const left = (px / 100) * W, right = left + label.length * 7 + 22;
      let row = rowEnd.findIndex(r => r < left);
      if (row === -1) row = rowEnd.length;
      rowEnd[row] = right;
      return { c, px, label, row };
    });
    const ROW = 26, axis = 8 + Math.max(rowEnd.length, 1) * ROW + 18;
    tl.style.setProperty("--axis", axis + "px");
    const path = opts.path && state.pathId ? resubmitPath(confs.find(c => c.id === state.pathId), now) : null;
    // home timeline: a clicked conference lights up where its paper could go next (no arcs, no panel)
    const glow = !opts.el && state.lightId ? resubmitPath(confs.find(c => c.id === state.lightId), now) : null;
    const lit = path || glow;
    const role = c => {
      if (!lit) return "";
      if (c === lit.src) return " tl-src";
      for (const st of lit.stages) {
        const i = st.list.indexOf(c);
        if (i !== -1) return ` tl-${st.key}${i < 3 ? " tl-top" : ""}`;
      }
      return " tl-dim";
    };
    pins.forEach(({ c, px, label, row }) => {
      const top = 8 + row * ROW;
      html += `<button type="button" class="tl-pin${c.status !== "confirmed" ? " est" : ""}${role(c)}" data-id="${esc(c.id)}"
        style="left:${px}%;top:${top}px;height:${axis + 5.5 - top}px" title="${esc(c.title + " " + c.year + " · " + fmtShort.format(c.ddl))}">
        <span class="lbl">${esc(label)}</span><span class="stem"></span><span class="dot"></span></button>`;
    });
    // review window of the selected conference, and arcs to where it could go next
    if (path) {
      const clampX = ms => Math.min(100, Math.max(0, x(ms)));
      const s = path.src;
      html += `<div class="tl-band" style="left:${clampX(s.ddl)}%;width:${clampX(s.dec) - clampX(s.ddl)}%"></div>`;
      if (s.reb) html += `<div class="tl-band tl-band-reb" style="left:${clampX(s.reb[0])}%;width:${clampX(s.dec) - clampX(s.reb[0])}%"></div>`;
      html += `<span class="tl-mark" style="left:${clampX(s.dec)}%">decision</span>`;
      if (s.reb) html += `<span class="tl-mark tl-mark-reb" style="left:${clampX(s.reb[0])}%">reviews</span>`;
      const arcs = path.stages.flatMap(st => st.list.slice(0, 5).filter(c => c.ddl < +end).map((c, i) => {
        const x1 = clampX(st.key === "reb" ? s.reb[0] : s.dec), x2 = clampX(c.ddl), depth = 22 + Math.min(44, Math.abs(x2 - x1) * 2.4);
        return `<path class="arc arc-${st.key}${i < 3 ? " arc-top" : ""}" d="M ${x1} 0 Q ${(x1 + x2) / 2} ${depth} ${x2} 0" />`;
      }));
      html += `<svg class="tl-arcs" viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true">${arcs.join("")}</svg>`;
    }
    tl.innerHTML = html + `</div>`;
    tl.classList.toggle("has-path", !!path);
    tl.classList.toggle("has-glow", !!glow);
    if (!opts.el) {
      const src = glow && glow.src;
      $("#tlLegend").innerHTML = src
        ? `<i class="lg lg-reb"></i>during ${esc(src.title)} rebuttal <i class="lg lg-dec"></i>after its decision <button type="button" class="lg-clear">clear</button>`
        : `<i class="lg lg-solid"></i>confirmed <i class="lg lg-hollow"></i>estimated`;
    }
    if (opts.path) renderPath(path, now);

    if (path && hasGsap && !reduced) {
      gsap.fromTo($$(".arc", tl), { opacity: 0 }, { opacity: (i, el) => (el.classList.contains("arc-top") ? 0.95 : 0.55), duration: 0.6, ease: "power2.out", stagger: 0.06 });
      gsap.fromTo($$(".tl-band", tl), { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out", transformOrigin: "left" });
    } else if (glow && hasGsap && !reduced) {
      gsap.fromTo($$(".tl-src .dot, .tl-reb .dot, .tl-dec .dot", tl), { scale: 0.3 }, { scale: 1, duration: 0.5, ease: "back.out(3)", stagger: 0.03 });
    } else if (hasGsap && !reduced && !opts.quiet) {
      gsap.fromTo($(".tl-axis", tl), { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "expo.inOut" });
      gsap.fromTo($$(".tl-pin", tl), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: "back.out(2)", stagger: 0.05, delay: 0.4 });
    }
  }

  /* ---------- resubmission path ---------- */

  // If a paper at `src` goes badly, where could it go next?
  //  · "rebuttal": deadlines between reviews coming out and the decision (withdraw and resubmit)
  //  · "decision": deadlines in the ~5 months after the decision
  // Ranked by the NYCU grade first (A, then B, then unlisted), then same field, then CCF as a tie-break,
  // then confirmed dates.
  const AFTER_DECISION = 150 * DAY;

  function resubmitPath(src, now) {
    if (!src || !src.dec) return null;
    const tier = c => ({ A: 3, B: 2 }[gradeOf(c)] || 1);
    const ccf = c => ({ A: 3, B: 2, C: 1 }[c.ccf] || 0);
    const score = c => tier(c) * 100 + (c.area.some(a => src.area.includes(a)) ? 40 : 0) + ccf(c) * 5 + (c.status === "confirmed" ? 1 : 0);
    const pool = confs.filter(c => c.kind !== "workshop" && seriesOf(c) !== seriesOf(src) && c.ddl > now);
    const within = (a, b) => pool.filter(c => c.ddl >= a && c.ddl < b).sort((p, q) => score(q) - score(p) || p.ddl - q.ddl);
    const stages = [];
    if (src.reb) stages.push({ key: "reb", from: src.reb[0], to: src.dec, list: within(Math.max(src.reb[0], now), src.dec) });
    stages.push({ key: "dec", from: src.dec, to: src.dec + AFTER_DECISION, list: within(Math.max(src.dec, now), src.dec + AFTER_DECISION) });
    return { src, stages, tier };
  }

  function renderPath(path, now) {
    const panel = $("#pathPanel");
    if (!path) { panel.innerHTML = `<p class="path-none">This conference has no announced decision date yet, so there is no path to plan.</p>`; return; }
    const s = path.src;
    const day = ms => fmtShort.format(ms);
    const item = (c, st, i) => {
      const gap = Math.round((c.ddl - st.from) / DAY);
      const tags = [
        gradeTag(c),
        c.ccf ? `<span class="tag">CCF-${esc(c.ccf)}</span>` : "",
        c.area.some(a => s.area.includes(a)) ? `<span class="tag tag-same">same field</span>` : "",
        c.status !== "confirmed" ? `<span class="tag tag-est">est.</span>` : "",
      ].join("");
      return `<li><button type="button" class="path-item${i === 0 ? " is-best" : ""}" data-id="${esc(c.id)}">
        <span class="pi-name">${esc(c.title)} ${esc(c.year)}${i === 0 ? ` <em>best match</em>` : ""}</span>
        <span class="pi-when">${day(c.ddl)} · ${gap >= 0 ? `+${gap}d` : `${gap}d`} after ${st.key === "reb" ? "reviews" : "decision"}</span>
        <span class="pi-tags">${tags}</span></button></li>`;
    };
    const stage = st => {
      const title = st.key === "reb"
        ? `During rebuttal <small>reviews ${fmtDay(s.rebuttal[0])} → decision ${fmtDay(s.decision)}</small>`
        : `After the decision <small>from ${fmtDay(s.decision)}, next ~5 months</small>`;
      const list = st.list.slice(0, 5);
      return `<div class="path-stage path-${st.key}"><h3>${title}</h3>${list.length
        ? `<ol>${list.map((c, i) => item(c, st, i)).join("")}</ol>${st.list.length > 5 ? `<p class="path-more">+${st.list.length - 5} more</p>` : ""}`
        : `<p class="path-none">No deadlines in this window.</p>`}</div>`;
    };
    panel.innerHTML = `<div class="path-head">
        <div><span class="path-kicker">Resubmission path</span>
        <b>${esc(s.title)} ${esc(s.year)}</b>
        <span class="path-flow">submit ${day(s.ddl)}${s.reb ? ` → reviews ${fmtDay(s.rebuttal[0])}` : ""} → decision ${fmtDay(s.decision)}</span></div>
      </div>
      <div class="path-stages">${path.stages.map(stage).join("")}</div>
      <p class="path-note">Ranked by ${esc((data.tiers && data.tiers.source) || "venue grade")}: grade A first, then B, then unlisted; then same field, with CCF as a tie-break. Check each venue's dual-submission and withdrawal rules before moving a paper.</p>`;
    if (hasGsap && !reduced) gsap.fromTo($$(".path-item", panel), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out", stagger: 0.03 });
  }

  /* ---------- planner (its own view, so the home screen stays clean) ---------- */

  const plannable = now => confs.filter(c => c.dec && c.kind !== "workshop" && (c.group === "up" || c.group === "review"))
    .sort((a, b) => a.ddl - b.ddl);

  function openPlanner(id) {
    const now = Date.now();
    const options = plannable(now);
    if (!options.length) return;
    const src = options.find(c => c.id === id) || options.find(c => c === heroConf) || options[0];
    state.pathId = src.id;
    $("#planSrc").innerHTML = options.map(c =>
      `<option value="${esc(c.id)}"${c === src ? " selected" : ""}>${esc(c.title)} ${esc(c.year)} — ${c.group === "review" ? "in review" : "due " + fmtShort.format(c.ddl)}</option>`).join("");
    const planner = $("#planner"), wasHidden = planner.hidden;
    planner.hidden = false;
    document.documentElement.classList.add("planner-open");
    history.replaceState(null, "", "#plan=" + src.id);
    renderTimeline(confs.filter(c => c.ddl > now && c.kind !== "workshop"), now, { el: $("#planTimeline"), path: true });
    if (wasHidden && hasGsap && !reduced) {
      gsap.fromTo(".planner-backdrop", { opacity: 0 }, { opacity: 1, duration: 0.3 });
      gsap.fromTo(".planner-sheet", { opacity: 0, y: 30, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "power3.out" });
    }
  }

  function closePlanner() {
    if ($("#planner").hidden) return;
    $("#planner").hidden = true;
    document.documentElement.classList.remove("planner-open");
    state.pathId = null;
    history.replaceState(null, "", location.pathname + location.search);
  }

  /* ---------- left rail ---------- */

  let railItems = [];

  function shortLeft(ms) {
    const t = split(ms);
    return t.d >= 1 ? `${t.d}d` : `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
  }

  // The rail lists only the conferences the viewer has starred, whatever the filters say.
  function renderRail(now) {
    const picked = confs.filter(c => isStarred(c));
    $("#railSel").textContent = state.starred.size ? [...state.starred].sort().join(" · ") : "";
    $("#railCount").textContent = state.starred.size ? `★ ${state.starred.size}` : "★";
    if (!picked.length) {
      $("#rail").innerHTML = `<p class="rail-empty">Click the <b>☆</b> next to a conference to follow it. You get every year of it here, including future editions.</p>`;
      railItems = [];
      return;
    }
    const up = picked.filter(c => c.group === "up");
    const review = picked.filter(c => c.group === "review");
    // decided editions: only the latest one per series, so the list stays short
    const done = picked.filter(c => c.group === "done" && !picked.some(o => o !== c && seriesOf(o) === seriesOf(c) && o.ddl > c.ddl));
    const item = (c, sub) => `<li><button type="button" class="rail-item${c.status !== "confirmed" ? " is-est" : ""}" data-id="${esc(c.id)}">
        <span class="r-name">${esc(c.title)} ${esc(c.year)}</span><span class="r-left"></span>
        <span class="r-sub">${esc(sub)}</span></button></li>`;
    $("#rail").innerHTML =
      (up.length ? `<div class="rail-group">Deadlines · ${up.length}</div><ul class="rail-list">${up.map(c => item(c, fmtShort.format(c.ddl) + (c.place && c.place !== "TBA" ? " · " + c.place : ""))).join("")}</ul>` : "") +
      (review.length ? `<div class="rail-group">In review · ${review.length}</div><ul class="rail-list">${review.map(c => item(c, "")).join("")}</ul>` : "") +
      (done.length ? `<div class="rail-group">Decided · ${done.length}</div><ul class="rail-list">${done.map(c => item(c, c.dec ? "decided " + fmtDay(c.decision) : "closed")).join("")}</ul>` : "");
    railItems = $$(".rail-item", $("#rail")).map(el => ({ el, c: confs.find(x => x.id === el.dataset.id) }));
    tickRail(now);
  }

  function tickRail(now) {
    for (const { el, c } of railItems) {
      const left = $(".r-left", el);
      el.classList.toggle("is-hero", c === heroConf);
      if (c.ddl > now) {
        left.textContent = shortLeft(c.ddl - now);
        const u = urgency(c.ddl - now);
        el.classList.toggle("u-hot", u === "hot");
        el.classList.toggle("u-warn", u === "warn");
        continue;
      }
      const ph = reviewPhase(c, now);
      if (!ph.label) { left.textContent = "✓"; continue; }
      left.textContent = shortLeft(ph.at - now);
      $(".r-sub", el).textContent = ph.label;
      el.classList.toggle("in-review", !ph.open);
      el.classList.toggle("in-rebuttal", !!ph.open);
    }
  }

  /* ---------- filters ---------- */

  function renderChips() {
    const counts = {};
    confs.forEach(c => c.area.forEach(a => { counts[a] = (counts[a] || 0) + 1; }));
    const order = Object.keys(data.areas).filter(a => counts[a]);
    $("#chips").innerHTML =
      `<button type="button" class="chip${state.areas.size ? "" : " is-on"}" data-area="">All</button>` +
      order.map(a => `<button type="button" class="chip${state.areas.has(a) ? " is-on" : ""}" data-area="${esc(a)}" title="${esc(data.areas[a])}">${esc(a)}<b>${counts[a]}</b></button>`).join("");
  }

  function apply({ animate = true } = {}) {
    const now = Date.now();
    const cards = confs.map(c => c.el);
    const useFlip = animate && hasGsap && window.Flip && !reduced;

    if (useFlip) {
      // Settle every row first: finish pending reveals and drop half-done tweens,
      // so Flip measures clean positions.
      gsap.killTweensOf(cards);
      confs.forEach(c => { if (c.group !== "done") c.revealed = true; });
      gsap.set(cards, { clearProps: "transform,opacity" });
    }
    const flipState = useFlip ? Flip.getState(cards) : null;

    const n = { up: 0, review: 0, done: 0 };
    const visible = [];
    for (const c of confs) {
      const show = matches(c);
      c.el.style.display = show ? "" : "none";
      if (show) { visible.push(c); n[c.group]++; }
    }
    $("#countUp").textContent = n.up;
    $("#countReview").textContent = n.review;
    $("#countPast").textContent = n.done;
    $("#emptyUp").hidden = n.up > 0;
    $("#emptyReview").hidden = n.review > 0;

    const upcomingVisible = visible.filter(c => c.ddl > now);
    refreshPicks(now);
    renderTimeline(upcomingVisible, now);
    renderRail(now);

    if (flipState) {
      Flip.from(flipState, {
        duration: 0.45, ease: "power3.inOut", stagger: 0.012,
        onEnter: els => gsap.fromTo(els, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }),
        onComplete: () => {
          gsap.set(cards, { clearProps: "transform,opacity" });
          if (window.ScrollTrigger) ScrollTrigger.refresh();
        },
      });
    }
  }

  function persist() {
    store.set("areas", [...state.areas]);
    store.set("onlyConfirmed", state.onlyConfirmed);
    store.set("ccfA", state.ccfA);
    store.set("gradeA", state.gradeA);
    store.set("onlyStarred", state.onlyStarred);
    store.set("starred", [...state.starred]);
  }

  function bind() {
    $("#chips").addEventListener("click", e => {
      const b = e.target.closest(".chip");
      if (!b) return;
      const a = b.dataset.area;
      if (!a) state.areas.clear();
      else state.areas.has(a) ? state.areas.delete(a) : state.areas.add(a);
      $$(".chip").forEach(el => el.classList.toggle("is-on", el.dataset.area ? state.areas.has(el.dataset.area) : !state.areas.size));
      persist();
      apply();
    });

    let qTimer;
    $("#q").addEventListener("input", e => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); apply(); }, 140);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
      if (e.key === "Escape" && document.activeElement === $("#q")) { $("#q").value = ""; state.q = ""; apply(); $("#q").blur(); }
    });

    const oc = $("#onlyConfirmed"), ca = $("#ccfA"), os = $("#onlyStarred");
    oc.checked = state.onlyConfirmed; ca.checked = state.ccfA; os.checked = state.onlyStarred;
    os.addEventListener("change", () => { state.onlyStarred = os.checked; persist(); apply(); });

    document.addEventListener("click", e => {
      const btn = e.target.closest(".star");
      if (!btn) return;
      const conf = confs.find(c => c.id === btn.closest(".card").dataset.id);
      const key = seriesOf(conf);
      const on = !state.starred.has(key);
      on ? state.starred.add(key) : state.starred.delete(key);
      confs.filter(c => seriesOf(c) === key).forEach(c => $(".star", c.el).setAttribute("aria-pressed", on));
      if (on && hasGsap && !reduced) gsap.fromTo(btn, { scale: 0.6, rotate: -30 }, { scale: 1, rotate: 0, duration: 0.5, ease: "back.out(3)" });
      persist();
      if (state.onlyStarred) apply();
      else { const now = Date.now(); refreshPicks(now); renderRail(now); }
    });
    oc.addEventListener("change", () => { state.onlyConfirmed = oc.checked; persist(); apply(); });
    ca.addEventListener("change", () => { state.ccfA = ca.checked; persist(); apply(); });
    const ga = $("#gradeA");
    ga.checked = state.gradeA;
    ga.addEventListener("change", () => { state.gradeA = ga.checked; persist(); apply(); });

    $$(".seg button").forEach(b => {
      b.classList.toggle("is-on", b.dataset.tz === state.tz);
      b.addEventListener("click", () => {
        state.tz = b.dataset.tz;
        store.set("tz", state.tz);
        $$(".seg button").forEach(x => x.classList.toggle("is-on", x === b));
        paintTimes();
      });
    });

    const root = document.documentElement;
    const savedTheme = store.get("theme", null);
    if (savedTheme) root.dataset.theme = savedTheme;
    $("#themeBtn").addEventListener("click", () => {
      const cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
      root.dataset.theme = cur === "light" ? "dark" : "light";
      store.set("theme", root.dataset.theme);
    });

    // Upcoming / In review / Decided fold open and shut; the choice is remembered.
    const folds = store.get("folds", { upcoming: true, review: true, passed: false });
    $$(".fold-toggle").forEach(btn => {
      const key = btn.dataset.fold, body = $("#fold-" + key);
      const set = (open, animate) => {
        btn.setAttribute("aria-expanded", open);
        body.hidden = !open;
        if (open && animate && hasGsap && !reduced) {
          gsap.fromTo($$(".card", body).filter(el => el.style.display !== "none").slice(0, 20),
            { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out", stagger: 0.02 });
        }
        if (window.ScrollTrigger) ScrollTrigger.refresh();
      };
      set(folds[key] !== false, false);
      btn.addEventListener("click", () => {
        const open = btn.getAttribute("aria-expanded") !== "true";
        folds[key] = open;
        store.set("folds", folds);
        set(open, true);
      });
    });

    $("#heroIcs").addEventListener("click", () => heroConf && icsFor(heroConf));

    // the background photo drifts a little with the mouse
    if (hasGsap && !reduced && matchMedia("(pointer: fine)").matches) {
      const panX = gsap.quickTo("#bgPan", "xPercent", { duration: 1.4, ease: "power3.out" });
      const panY = gsap.quickTo("#bgPan", "yPercent", { duration: 1.4, ease: "power3.out" });
      window.addEventListener("pointermove", e => {
        panX((e.clientX / innerWidth - 0.5) * -4.5);
        panY((e.clientY / innerHeight - 0.5) * -1.5);
      }, { passive: true });
    }

    // back-to-top button, only once the hero is out of view
    const toTop = $("#toTop");
    const syncTop = () => { toTop.hidden = window.scrollY < 600; };
    window.addEventListener("scroll", syncTop, { passive: true });
    syncTop();
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }));

    const layout = $(".layout"), rt = $("#railToggle");
    const setRail = open => {
      layout.classList.toggle("rail-off", !open);
      rt.setAttribute("aria-expanded", open);
      rt.title = open ? "Collapse sidebar" : "Show My conferences";
      store.set("railOpen", open);
    };
    setRail(store.get("railOpen", true));
    // On narrow screens the sidebar is a drawer: the tab opens it, « or the backdrop closes it.
    const narrowRail = matchMedia("(max-width: 1100px)");
    const setDrawer = open => layout.classList.toggle("drawer-open", open);
    rt.addEventListener("click", () => {
      if (narrowRail.matches) { setDrawer(false); return; }
      setRail(layout.classList.contains("rail-off"));
      if (window.ScrollTrigger) setTimeout(() => ScrollTrigger.refresh(), 400);
    });
    $("#railTab").addEventListener("click", () => setDrawer(true));
    $("#railBackdrop").addEventListener("click", () => setDrawer(false));
    $("#rail").addEventListener("click", e => { if (narrowRail.matches && e.target.closest(".rail-item")) setDrawer(false); });
    narrowRail.addEventListener("change", () => setDrawer(false));
    $("#heroPicks").addEventListener("click", e => {
      const btn = e.target.closest(".pick");
      if (!btn) return;
      state.manualId = null;
      if (state.lightId) { state.lightId = null; renderTimeline(timelineList, Date.now(), { quiet: true }); }
      state.heroMode = btn.dataset.mode;
      store.set("heroMode", state.heroMode);
      refreshPicks(Date.now());
    });

    const jump = e => {
      const pin = e.target.closest(".tl-pin, .rail-item");
      if (!pin) return;
      const c = confs.find(x => x.id === pin.dataset.id);
      if (!c) return;
      const body = c.el.closest(".fold-body");
      if (body && body.hidden) $(`.fold-toggle[data-fold="${body.id.slice(5)}"]`).click(); // open a folded section first
      c.el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      c.el.classList.remove("flash");
      void c.el.offsetWidth;
      c.el.classList.add("flash");
    };
    $("#timeline").addEventListener("click", e => {
      const pin = e.target.closest(".tl-pin");
      if (!pin) return;
      // click lights up the next venues (and shows it in the big countdown); clicking it again clears
      const again = state.lightId === pin.dataset.id;
      state.lightId = again ? null : pin.dataset.id;
      state.manualId = again ? null : pin.dataset.id;
      refreshPicks(Date.now());
      renderTimeline(timelineList, Date.now(), { quiet: true });
      if (again) return;
      const top = $("#hero").getBoundingClientRect().top + window.scrollY - 70;
      if (window.scrollY > top) window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    });

    $("#tlLegend").addEventListener("click", e => {
      if (!e.target.closest(".lg-clear")) return;
      state.lightId = null; state.manualId = null;
      refreshPicks(Date.now());
      renderTimeline(timelineList, Date.now(), { quiet: true });
    });

    // planner: top-bar button, "Plan resubmission" in a row, or a #plan=<id> link
    $("#plannerBtn").addEventListener("click", () => openPlanner(heroConf && heroConf.id));
    document.addEventListener("click", e => {
      const btn = e.target.closest(".c-plan");
      if (btn) openPlanner(btn.closest(".card").dataset.id);
    });
    $("#planner").addEventListener("click", e => {
      if (e.target.closest("[data-close]")) return closePlanner();
      const hop = e.target.closest(".path-item, .tl-pin");
      if (hop) openPlanner(hop.dataset.id); // chain: plan the next hop from the chosen venue
    });
    $("#planSrc").addEventListener("change", e => openPlanner(e.target.value));
    document.addEventListener("keydown", e => { if (e.key === "Escape") closePlanner(); });
    $("#rail").addEventListener("click", jump);

    // rows fold open to show the details
    document.addEventListener("click", e => {
      const btn = e.target.closest(".row-toggle");
      if (!btn) return;
      const card = btn.closest(".card"), more = $(".row-more", card);
      const open = !card.classList.contains("is-open");
      card.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open);
      if (open) more.hidden = false;
      if (hasGsap && !reduced) {
        gsap.fromTo(more, { height: open ? 0 : more.offsetHeight, opacity: open ? 0 : 1 },
          { height: open ? "auto" : 0, opacity: open ? 1 : 0, duration: 0.3, ease: "power2.out",
            onComplete: () => { if (!open) more.hidden = true; gsap.set(more, { clearProps: "height,opacity" }); } });
      } else if (!open) more.hidden = true;
    });

    if (hasGsap && window.ScrollTrigger) {
      ScrollTrigger.create({
        trigger: ".controls", start: "top 64px", end: "max",
        onToggle: self => $(".controls").classList.toggle("is-stuck", self.isActive),
      });
    }
  }

  /* ---------- lifecycle ---------- */

  function build() {
    const now = Date.now();
    confs = data.conferences
      .map(c => ({
        ...c, area: c.area || [],
        ddl: parseDeadline(c.deadline, c.timezone),
        abs: parseDeadline(c.abstract_deadline, c.timezone),
        // rebuttal opens at the start of its first day and closes at the end of its last
        reb: Array.isArray(c.rebuttal) ? [parseDeadline(c.rebuttal[0].slice(0, 10) + " 00:00", c.timezone), parseDeadline(c.rebuttal[1], c.timezone)] : null,
        dec: c.decision ? parseDeadline(c.decision.slice(0, 10) + " 00:00", c.timezone) : null,
      }))
      .filter(c => c.ddl != null);
    // Three groups: still open, submitted and in review, decided.
    confs.forEach(c => {
      c.phase = c.ddl > now ? null : reviewPhase(c, now);
      c.group = c.ddl > now ? "up" : c.phase.label ? "review" : "done";
    });
    const up = confs.filter(c => c.group === "up").sort((a, b) => a.ddl - b.ddl);
    const review = confs.filter(c => c.group === "review").sort((a, b) => a.phase.at - b.phase.at);
    const past = confs.filter(c => c.group === "done").sort((a, b) => b.ddl - a.ddl);
    confs = [...up, ...review, ...past];
    // rebuild when a deadline passes or a paper in review gets its decision
    const idToSeries = new Map(confs.map(c => [c.id, seriesOf(c)]));
    const migrated = new Set([...state.starred].map(k => idToSeries.get(k) || k));
    if (migrated.size !== state.starred.size || [...migrated].some(k => !state.starred.has(k))) {
      state.starred = migrated;
      store.set("starred", [...migrated]);
    }
    nextBoundary = Math.min(up.length ? up[0].ddl : Infinity, ...review.map(c => c.dec || Infinity));

    const upEl = $("#upcoming"), reviewEl = $("#review"), pastEl = $("#passed");
    upEl.innerHTML = ""; reviewEl.innerHTML = ""; pastEl.innerHTML = "";
    up.forEach(c => upEl.appendChild(buildCard(c)));
    review.forEach(c => { reviewEl.appendChild(buildCard(c)); c.el.classList.add("is-past"); });
    past.forEach(c => { pastEl.appendChild(buildCard(c)); c.el.classList.add("is-past"); });

    renderChips();
    paintTimes();
    apply({ animate: false });
    confs.forEach(c => tickCard(c, now));
    revealCards([...up, ...review]);
  }

  function revealCards(list) {
    const growBar = c => {
      c.barShown = true;
      const left = c.ddl - Date.now();
      const w = (Math.min(1, Math.max(0, 1 - left / BAR_WINDOW)) * 100) + "%";
      if (hasGsap && !reduced) gsap.fromTo(c.refs.bar, { width: "0%" }, { width: w, duration: 1.4, ease: "expo.out" });
      else c.refs.bar.style.width = w;
    };
    if (!hasGsap || reduced || !window.ScrollTrigger) { list.forEach(growBar); return; }
    gsap.set(list.map(c => c.el), { opacity: 0, y: 14 });
    ScrollTrigger.batch(list.map(c => c.el), {
      start: "top 92%", once: true,
      onEnter: els => {
        // skip rows a filter change already revealed, so this never fights a running Flip
        const fresh = els.map(el => list.find(x => x.el === el)).filter(c => c && !c.revealed);
        if (!fresh.length) return;
        fresh.forEach(c => { c.revealed = true; growBar(c); });
        gsap.to(fresh.map(c => c.el), { opacity: 1, y: 0, duration: 0.6, ease: "expo.out", stagger: 0.035 });
      },
    });
  }

  const fmtNowLocal = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
  const fmtNowAoE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Etc/GMT+12" });

  const narrow = matchMedia("(max-width: 640px)");
  const fmtNowShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function tickNow(now) {
    $("#nowLocal").textContent = (narrow.matches ? fmtNowShort : fmtNowLocal).format(now);
    $("#nowAoE").textContent = fmtNowAoE.format(now);
  }

  function tick() {
    const now = Date.now();
    tickNow(now);
    if (now >= nextBoundary) { heroConf = null; heroPick = null; build(); }
    refreshPicks(now);
    tickRail(now);
    for (const c of confs) if (c.el.style.display !== "none") tickCard(c, now);
  }

  async function init() {
    bind();
    tickNow(Date.now());
    try {
      const res = await fetch("data/conferences.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (err) {
      $("#heroFull").textContent = "Couldn't load data/conferences.json. Serve this folder over HTTP (e.g. python3 -m http.server).";
      console.error(err);
      return;
    }
    if (data.updated) $("#updated").textContent = "updated " + data.updated;
    build();
    const planHash = location.hash.match(/^#plan=([\w-]+)/);
    if (planHash) openPlanner(planHash[1]);
    tick();
    // align ticks to the wall-clock second
    setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000 - (Date.now() % 1000));
  }

  init();
})();
