(() => {
  "use strict";

  const DAY = 864e5;
  const HOT_DAYS = 7;
  const WARN_DAYS = 30;
  const BAR_WINDOW = 180 * DAY; // the progress bar fills over the last 180 days
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Phones and touch screens: skip the decorative intros (title letters, timeline draw-in, row reveal) and keep the
  // functional motion (digit flips, reorder, folds) short, so the first seconds stay responsive.
  const lite = matchMedia("(max-width: 760px), (pointer: coarse)").matches;
  const fx = !reduced && !lite;     // decorative motion
  const dur = s => (lite ? Math.min(s, 0.25) : s);
  const hasGsap = typeof window.gsap !== "undefined";
  if (hasGsap && window.Flip) gsap.registerPlugin(Flip);
  if (hasGsap && window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

  // Build id from our own script URL (?v=<commit> on the live site, "dev" locally). Data URLs carry it too, so they
  // match the <link rel="preload"> in index.html and every deploy busts the browser cache.
  const BUILD = (document.currentScript && new URL(document.currentScript.src).searchParams.get("v")) || "dev";
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
  // workshop proposals and challenges take no papers, so the planner never suggests them
  const notPaper = c => c.kind === "workshop" || c.kind === "challenge";
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
      (c.kind === "workshop" ? `<span class="tag tag-ws">workshop proposals</span>` : c.kind === "workshop-paper" ? `<span class="tag tag-ws">workshop</span>` :
       c.kind === "challenge" ? `<span class="tag tag-ws">challenge</span>` : "");
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
    c.el = el;
    el.conf = c;
    cardIO.observe(el);
    c.refs = {
      days: $(".c-days", el), unit: $(".c-unit", el), hms: $(".c-hms", el), bar: $(".bar i", el),
      ddl: $(".c-ddl", el), abs: null, steps,
    };
    return el;
  }

  // The fold-out details (venue, note, links) are built the first time a row is opened.
  function buildMore(c) {
    const more = $("#moreTpl").content.firstElementChild.cloneNode(true);
    $(".c-date", more).textContent = c.date || "TBA";
    $(".c-place", more).textContent = c.place || "TBA";
    if (c.note) $(".c-note", more).textContent = c.note; else $(".c-note", more).remove();
    if (c.abs) { c.refs.abs = $(".c-abs dd", more); c.refs.abs.textContent = fmtTime(c.abs); } else $(".c-abs", more).remove();
    if (!c.decision || notPaper(c)) $(".c-plan", more).remove();
    $(".c-link", more).href = c.link;
    $(".c-ics", more).addEventListener("click", () => icsFor(c));
    c.el.appendChild(more);
    return more;
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
        gsap.fromTo(neu, { yPercent: -100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: dur(0.5), ease: "expo.out" });
        gsap.to(old, { yPercent: 100, opacity: 0, duration: dur(0.5), ease: "expo.out", onComplete: () => old.remove() });
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

  // Host city card next to the clock; the page background is a scenery photo of the place.
  const COUNTRY_NAMES = { USA: "United States", UK: "United Kingdom" };

  // "City, Country" → city + country. When only the country is known — "Japan (TBA)", "TBA, Japan" —
  // city is empty and photos are filed under the country. Same rule as city_of() in scripts/fetch_city_photos.py.
  function venueOf(place) {
    if (!place || /^\s*TBA\s*$/i.test(place)) return { city: "", country: "", key: "" };
    if (/^\s*(?:virtual|online)\s*$/i.test(place)) return { city: "", country: "", key: "", virtual: true };
    const unsure = /\((?:TBA|tentative)\)/i.test(place);
    const parts = place.replace(/\s*\((?:TBA|tentative)\)/gi, "").split(",").map(x => x.trim()).filter(Boolean);
    if (parts[0] && /^TBA$/i.test(parts[0])) parts.shift();
    if (parts.length > 1) return { city: parts.slice(0, -1).join(", "), country: parts[parts.length - 1], key: parts.slice(0, -1).join(", ") };
    const one = parts[0] || "";
    return unsure || /^TBA,/i.test(place.trim()) ? { city: "", country: one, key: one } : { city: one, country: "", key: one };
  }
  // data/cities.json: scenery photos from scripts/fetch_city_photos.py (Unsplash). A place without any yet shows no photo.
  let cityPhotos = {};
  const loadCityPhotos = fetch(`data/cities.json?v=${BUILD}`)
    .then(r => (r.ok ? r.json() : {})).then(j => { cityPhotos = j || {}; }).catch(() => {});

  // Entrance tweens end with clearProps: "transform" — a leftover transform on an element or its parent turns the
  // glass light's background-attachment: fixed into local, which would put the light in the wrong place.

  // Several photos per city; show a different one each time (never the same twice in a row).
  const lastPhoto = {};
  const photosOf = city => {
    const entry = cityPhotos[city];
    return entry ? (entry.photos || (entry.src ? [entry] : [])) : [];
  };
  function pickCityPhoto(city, advance) {
    const list = photosOf(city);
    if (!list.length) return null;
    let i = advance && lastPhoto[city] != null ? lastPhoto[city] + 1 : Math.floor(Math.random() * list.length);
    if (!advance && list.length > 1 && i === lastPhoto[city]) i += 1;
    i %= list.length;
    lastPhoto[city] = i;
    // ask the CDN for a size that fits the screen (≈300–400 KB as AVIF/WebP instead of ~1 MB)
    const w = innerWidth > 1800 ? 2000 : innerWidth > 900 ? 1600 : 1000;
    return { ...list[i], src: list[i].src.replace(/([?&])w=\d+/, `$1w=${w}`).replace(/([?&])q=\d+/, "$1q=70") };
  }

  async function setVenue(c, advance = false) {
    const fig = $("#venue"), img = $("#venueImg"), credit = $("#venueCredit");
    img.classList.remove("is-loaded");
    credit.hidden = true;
    const { city, country, key, virtual } = venueOf(c && c.place);
    const place = key;
    fig.classList.toggle("is-tba", !place);
    // only the country known ("Japan (TBA)" or "TBA, Japan"): show the country, file the photo under it
    $("#venueCity").textContent = !place ? (virtual ? "Online" : "Venue to be announced") : city || COUNTRY_NAMES[country] || country;
    $("#venueCountry").textContent = city ? country : place ? "city TBA" : "";
    $("#venueDates").textContent = c ? c.date || "" : "";
    if (!place) return;
    const token = (fig.dataset.token = String(Math.random()));
    await loadCityPhotos;
    const un = pickCityPhoto(key, advance);
    const many = photosOf(key).length;
    $("#photoNext").hidden = many < 2;
    $("#photoCount").textContent = many > 1 ? `${lastPhoto[key] + 1}/${many}` : "";
    if (!un || fig.dataset.token !== token) return;
    const found = { src: un.src, unsplash: un };
    const pre = new Image();
    pre.crossOrigin = "anonymous"; // matches how the service worker fetches, so both share one cached copy
    pre.onload = () => {
      if (fig.dataset.token !== token) return;
      img.style.backgroundImage = `url("${found.src}")`;
      img.classList.add("is-loaded");
      const u = found.unsplash;
      credit.innerHTML = `Photo by <a href="${esc(u.photographer_url)}" target="_blank" rel="noopener">${esc(u.photographer)}</a>` +
        ` on <a href="${esc(u.photo_url)}" target="_blank" rel="noopener">Unsplash</a>`;
      credit.hidden = false;
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
    if (hasGsap && fx) {
      gsap.fromTo(chars, { yPercent: 110 }, { yPercent: 0, duration: first ? 1.1 : 0.7, ease: "expo.out", stagger: 0.04, delay: first ? 0.15 : 0 });
      gsap.fromTo(["#heroYear", "#heroFull", ".hero-foot"], { opacity: 0, y: 12 }, { opacity: 1, y: 0, clearProps: "transform", duration: 0.7, ease: "power3.out", stagger: 0.06, delay: first ? 0.4 : 0.1 });
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
    // the past three months for context, then this month and the next nine
    const start = new Date(now); start.setDate(1); start.setHours(0, 0, 0, 0); start.setMonth(start.getMonth() - 3);
    const end = new Date(start); end.setMonth(end.getMonth() + 13);
    const span = end - start;
    const x = ms => ((ms - start) / span) * 100;

    let html = `<div class="timeline-inner"><div class="tl-axis"></div>`;
    for (let i = 1; i < 13; i++) { // no labels on the edges, they would be clipped
      const m = new Date(start); m.setMonth(m.getMonth() + i);
      const label = m.toLocaleString(undefined, { month: "short" }) + (m.getMonth() === 0 ? ` ’${String(m.getFullYear()).slice(2)}` : "");
      html += `<span class="tl-month" style="left:${x(+m)}%">${esc(label)}</span>`;
    }
    html += `<div class="tl-past" style="width:${x(now)}%"></div><div class="tl-today" style="left:${x(now)}%"></div>`;

    // Labels hang to the right of their pin; stack them on rows so none overlap.
    // phones scroll a wider strip sideways (see style.css); the label budget keeps the height fixed
    const narrow = matchMedia("(max-width: 640px)").matches; // same breakpoint as the scrolling strip in style.css
    const W = Math.max(tl.clientWidth, 720), MAXROW = 3; // 3 rows of names; a clicked conference adds a 4th for its dates
    // one labelled block per conference, at its deadline; a conference in review also gets a small dot on the
    // axis at its next date — amber for rebuttal (when it opens, or closes once open), green for the decision
    const next = c => {
      if (c.ddl > now) return null;
      if (c.reb && now < c.reb[1]) return { at: now < c.reb[0] ? c.reb[0] : c.reb[1], ev: "reb" };
      if (c.dec && now < c.dec) return { at: c.dec, ev: "dec" };
      return null;
    };
    // a clicked conference also gets its other dates as blocks of their own, labelled with the date
    const sel = !opts.el && state.lightId && list.find(c => c.id === state.lightId);
    const extra = !sel ? [] : [
      null,
      sel.reb && { c: sel, at: sel.reb[0], ev: "reb", text: `Rebuttal ${fmtRange(sel.rebuttal)}` },
      sel.dec && { c: sel, at: sel.dec, ev: "dec", text: `Decision ${fmtDay(sel.decision)}` },
    ].slice(1).filter(Boolean);
    const events = [...list.map(c => ({ c, at: c.ddl, ev: "ddl" })), ...extra].filter(e => e.at >= +start && e.at < +end).sort((a, b) => a.at - b.at);
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
    // labels go to the most useful blocks first; the rest stay as bare dots (name on hover)
    const rank = e => (e.text || e.c.id === state.lightId ? 1e4 : 0) + (lit && role(e.c) && !role(e.c).includes("dim") ? 2000 : 0)
      + (isStarred(e.c) ? 1000 : 0) + (e.at > now ? 500 : 0) + ({ A: 200, B: 100 }[gradeOf(e.c)] || 0) + (e.c.status === "confirmed" ? 10 : 0) - e.at / 1e13;
    const rows = Array.from({ length: MAXROW }, () => []);
    const pins = events.map(e => {
      const px = x(e.at);
      const label = e.text || `${e.c.title} ${String(e.c.year).slice(2)}`;
      const lw = label.length * 7.8 + 24, at = (px / 100) * W;
      // near the right edge a label hangs left; the clicked conference's rebuttal hangs left too, so it and the decision share a row
      const flip = e.text && e.ev === "reb" ? at - lw >= 0 : at + lw > W;
      const left = at - (flip ? lw : 0);
      return { ...e, px, label, flip, l: left, r: left + lw, row: -1 };
    });
    [...pins].filter(p => !p.text).sort((p, q) => rank(q) - rank(p)).forEach(p => {
      p.row = rows.findIndex(r => r.every(([l, rr]) => p.r < l || p.l > rr));
      if (p.row !== -1) rows[p.row].push([p.l, p.r]);
    });
    let used = rows.filter(r => r.length).length;
    const dated = pins.filter(p => p.text);
    dated.forEach(p => (p.row = used)); // the row right above the axis
    if (dated.length) used += 1;
    const ROW = 26, axis = 8 + Math.max(used, 1) * ROW + 18;
    tl.style.setProperty("--axis", axis + "px");
    const tipOf = c => [`${c.title} ${c.year}`, `deadline ${fmtShort.format(c.ddl)}`, c.reb && `rebuttal ${fmtRange(c.rebuttal)}`, c.dec && `decision ${fmtDay(c.decision)}`].filter(Boolean).join(" · ");
    pins.forEach(({ c, at, ev, px, label, row, flip }) => {
      if (row === -1) {
        html += `<button type="button" class="tl-bare${ev === "ddl" ? (c.status !== "confirmed" ? " est" : "") : ` ev-${ev}`}${at <= now ? " past" : ""}${role(c)}"
          data-id="${esc(c.id)}" style="left:${px}%" title="${esc(tipOf(c))}" aria-label="${esc(tipOf(c))}"></button>`;
        return;
      }
      const top = 8 + row * ROW;
      const cls = (ev === "ddl" ? (c.status !== "confirmed" ? " est" : "") : ` ev-${ev}`) + role(c);
      html += `<button type="button" class="tl-pin${cls}${at <= now ? " past" : ""}${flip ? " flip" : ""}" data-id="${esc(c.id)}"
        style="${flip ? `right:${100 - px}%` : `left:${px}%`};top:${top}px;height:${axis + 5.5 - top}px" title="${esc(tipOf(c))}">
        <span class="lbl">${esc(label)}</span><span class="stem"></span><span class="dot"></span></button>`;
    });
    if (!opts.el) list.forEach(c => {
      const n = c !== sel && next(c);
      if (!n || n.at >= +end) return;
      html += `<button type="button" class="tl-dot ev-${n.ev}${role(c)}" data-id="${esc(c.id)}" style="left:${x(n.at)}%"
        title="${esc(tipOf(c))}" aria-label="${esc(tipOf(c))}"></button>`;
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
    // phones: the same dates as a list, one row per month
    if (narrow && !opts.el) {
      const items = [...events, ...list.filter(c => c !== sel).map(c => ({ c, ...(next(c) || {}) })).filter(e => e.ev && e.at < +end)];
      const months = Array.from({ length: 13 }, (_, i) => { const m = new Date(start); m.setMonth(m.getMonth() + i); return { m, items: [] }; });
      items.forEach(e => {
        const d = new Date(e.at), i = (d.getFullYear() - start.getFullYear()) * 12 + d.getMonth() - start.getMonth();
        if (months[i]) months[i].items.push(e);
      });
      const thisMonth = new Date(now).getMonth(), thisYear = new Date(now).getFullYear();
      html = `<div class="tl-months">` + months.map(({ m, items }) => {
        const isNow = m.getMonth() === thisMonth && m.getFullYear() === thisYear, isPast = !isNow && +m < now;
        const name = m.toLocaleString(undefined, { month: "short" }), yr = m.getMonth() === 0 || isNow ? ` ’${String(m.getFullYear()).slice(2)}` : "";
        const chips = items.sort((a, b) => a.at - b.at).map(e => {
          const cls = `tl-chip ev-${e.ev}${e.ev === "ddl" && e.c.status !== "confirmed" ? " est" : ""}${e.at <= now ? " past" : ""}${role(e.c)}`;
          const text = e.text || `${e.c.title} ${String(e.c.year).slice(2)}`;
          return `<button type="button" class="${cls}" data-id="${esc(e.c.id)}" title="${esc(tipOf(e.c))}">${esc(text)}${e.text ? "" : `<small>${new Date(e.at).getDate()}</small>`}</button>`;
        }).join("");
        return `<div class="tl-mrow${isNow ? " is-now" : ""}${isPast ? " is-past" : ""}"><span class="tl-mname">${esc(name)}<small>${esc(yr)}</small></span><div class="tl-mchips">${chips || `<span class="tl-mempty">—</span>`}</div></div>`;
      }).join("") + `</div>`;
      const keep = $(".tl-months", tl)?.scrollTop;
      tl.innerHTML = html;
      if (opts.quiet && keep != null) $(".tl-months", tl).scrollTop = keep; // a tap re-renders; stay where the reader was
      else { const row = $(".tl-mrow.is-now", tl), box = $(".tl-months", tl); if (row && box) box.scrollTop = row.offsetTop - box.offsetTop - 8; }
    } else {
      tl.innerHTML = html + `</div>`;
    }
    tl.classList.toggle("has-path", !!path);
    tl.classList.toggle("has-glow", !!glow);
    if (!opts.el) {
      const src = glow && glow.src;
      $("#tlLegend").innerHTML = src
        ? `<span><i class="lg lg-reb"></i>during ${esc(src.title)} rebuttal</span> <span><i class="lg lg-dec"></i>after its decision</span> <button type="button" class="lg-clear">clear</button>`
        : `<span><i class="lg lg-solid"></i>deadline</span> <span><i class="lg lg-hollow"></i>estimated</span> <span><i class="lg lg-bar"></i>rebuttal</span> <span><i class="lg lg-dia"></i>decision</span>`;
    }
    if (opts.path) renderPath(path, now);

    if (path && hasGsap && !reduced) {
      gsap.fromTo($$(".arc", tl), { opacity: 0 }, { opacity: (i, el) => (el.classList.contains("arc-top") ? 0.95 : 0.55), duration: 0.6, ease: "power2.out", stagger: 0.06 });
      gsap.fromTo($$(".tl-band", tl), { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out", transformOrigin: "left" });
    } else if (glow && hasGsap && !reduced && $(".tl-axis", tl)) {
      gsap.fromTo($$(".tl-src .dot, .tl-reb .dot, .tl-dec .dot", tl), { scale: 0.3 }, { scale: 1, duration: 0.5, ease: "back.out(3)", stagger: 0.03 });
    } else if (hasGsap && fx && !opts.quiet && $(".tl-axis", tl)) {
      gsap.fromTo($(".tl-axis", tl), { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "expo.inOut" });
      gsap.fromTo($$(".tl-pin", tl), { opacity: 0, y: 14 }, { opacity: 1, y: 0, clearProps: "transform", duration: 0.6, ease: "back.out(2)", stagger: { amount: 0.9 }, delay: 0.4 });
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
    const pool = confs.filter(c => !notPaper(c) && seriesOf(c) !== seriesOf(src) && c.ddl > now);
    const within = (a, b) => pool.filter(c => c.ddl >= a && c.ddl < b).sort((p, q) => score(q) - score(p) || p.ddl - q.ddl);
    const stages = [];
    if (src.reb) stages.push({ key: "reb", from: src.reb[0], to: src.dec, list: within(Math.max(src.reb[0], now), src.dec) });
    stages.push({ key: "dec", from: src.dec, to: src.dec + AFTER_DECISION, list: within(Math.max(src.dec, now), src.dec + AFTER_DECISION) });
    return { src, stages, tier };
  }

  function renderPath(path, now) {
    const card = $("#planSrcCard"), panel = $("#pathPanel");
    if (!path) {
      card.innerHTML = "";
      panel.innerHTML = `<p class="lane-empty">This conference has no announced decision date yet, so there is no path to plan.</p>`;
      return;
    }
    const s = path.src;
    const rel = ms => {
      const d = Math.round((ms - now) / DAY);
      return d > 0 ? `in ${d}d` : d === 0 ? "today" : `${-d}d ago`;
    };
    const tags = c => [gradeTag(c), c.ccf ? `<span class="tag">CCF-${esc(c.ccf)}</span>` : "",
      c.status !== "confirmed" ? `<span class="tag tag-est">est.</span>` : ""].join("");

    // the paper's own timeline: submit → reviews → decision
    const steps = [["Submit", s.ddl, fmtDay(s.deadline)]];
    if (s.reb) steps.push(["Reviews out", s.reb[0], fmtDay(s.rebuttal[0])]);
    steps.push(["Decision", s.dec, fmtDay(s.decision)]);
    card.innerHTML = `<div class="ps-card">
        <div class="ps-id"><b>${esc(s.title)} <span>${esc(s.year)}</span></b><span class="ps-tags">${tags(s)}</span>
          <small>${esc(s.full_name)}</small></div>
        <ol class="ps-steps">${steps.map(([label, at, day]) =>
          `<li class="${at <= now ? "done" : ""}"><i></i><span>${label}</span><b>${day}</b><small>${rel(at)}</small></li>`).join("")}</ol>
      </div>`;

    const item = (c, st, i) => {
      const gap = Math.round((c.ddl - st.from) / DAY);
      const same = c.area.some(a => s.area.includes(a));
      return `<li><button type="button" class="pp-item${i === 0 ? " is-best" : ""}" data-id="${esc(c.id)}" title="Plan the next step from ${esc(c.title)} ${esc(c.year)}">
        <span class="pp-rank">${i + 1}</span>
        <span class="pp-main"><b>${esc(c.title)} ${esc(c.year)}</b><span class="pp-tags">${tags(c)}${same ? `<span class="tag tag-same">same field</span>` : ""}</span></span>
        <span class="pp-when"><b>${fmtShort.format(c.ddl)}</b><small>+${gap}d after ${st.key === "reb" ? "reviews" : "decision"}</small></span>
      </button></li>`;
    };
    const lane = st => {
      const reb = st.key === "reb";
      const list = st.list.slice(0, 6);
      return `<section class="lane lane-${st.key}">
        <header><span class="lane-dot"></span><div>
          <h3>${reb ? "During the rebuttal" : "After the decision"}</h3>
          <p>${reb ? `Deadlines ${fmtDay(s.rebuttal[0])} – ${fmtDay(s.decision)}` : `Deadlines from ${fmtDay(s.decision)}, next ~5 months`}</p>
        </div><span class="lane-count">${st.list.length}</span></header>
        ${list.length ? `<ol>${list.map((c, i) => item(c, st, i)).join("")}</ol>` : `<p class="lane-empty">No conference deadline falls in this window.</p>`}
        ${st.list.length > 6 ? `<p class="lane-more">+${st.list.length - 6} more</p>` : ""}
      </section>`;
    };
    panel.innerHTML = `<div class="pp-lanes">${path.stages.map(lane).join("")}</div>
      <p class="pp-note">Ranked by ${esc((data.tiers && data.tiers.source) || "venue grade")} (A, then B, then unlisted), then same field, with CCF as a tie-break.
      Click a venue to plan the next step from there. Check each venue's dual-submission and withdrawal rules before moving a paper.</p>`;
  }


  /* ---------- planner (its own view, so the home screen stays clean) ---------- */

  const plannable = now => confs.filter(c => c.dec && !notPaper(c) && (c.group === "up" || c.group === "review"))
    .sort((a, b) => a.ddl - b.ddl);

  function openPlanner(id) {
    const now = Date.now();
    const options = plannable(now);
    if (!options.length) return;
    const src = options.find(c => c.id === id) || options.find(c => c === heroConf) || options[0];
    state.pathId = src.id;
    $("#planSrc").innerHTML = options.map(c =>
      `<option value="${esc(c.id)}"${c === src ? " selected" : ""}>${esc(c.title)} ${esc(c.year)} — ${c.group === "review" ? "in review" : "due " + fmtDay(c.deadline)}</option>`).join("");
    const planner = $("#planner"), wasHidden = planner.hidden;
    planner.hidden = false;
    document.documentElement.classList.add("planner-open");
    history.replaceState(null, "", "#plan=" + src.id);
    // the planner's timeline only shows the paper and where it could go, which keeps it readable (and light)
    const path = resubmitPath(src, now);
    const onTl = new Set([src, ...(path ? path.stages.flatMap(st => st.list.slice(0, 6)) : [])]);
    renderTimeline([...onTl].sort((a, b) => a.ddl - b.ddl), now, { el: $("#planTimeline"), path: true });
    if (wasHidden && hasGsap && !reduced) {
      gsap.fromTo(".planner-backdrop", { opacity: 0 }, { opacity: 1, duration: dur(0.3) });
      gsap.fromTo(".planner-sheet", { opacity: 0, y: lite ? 12 : 30, scale: lite ? 1 : 0.98 }, { opacity: 1, y: 0, clearProps: "transform", scale: 1, duration: lite ? 0.2 : 0.45, ease: "power3.out" });
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
    // every upcoming date of the followed conferences in one list, soonest first:
    // abstract / submission deadlines, rebuttal opens / closes, decision
    const events = picked.flatMap(c => [
      c.abs && { c, at: c.abs, kind: "ddl", what: "Abstract" },
      { c, at: c.ddl, kind: "ddl", what: "Submission" },
      c.reb && { c, at: c.reb[0], kind: "reb", what: "Rebuttal opens", day: fmtDay(c.rebuttal[0]) },
      c.reb && { c, at: c.reb[1], kind: "reb", what: "Rebuttal closes", day: fmtDay(c.rebuttal[1]) },
      c.dec && { c, at: c.dec, kind: "dec", what: "Decision", day: fmtDay(c.decision) },
    ]).filter(e => e && e.at > now).sort((a, b) => a.at - b.at);
    // decided editions: only the latest one per series, so the list stays short
    const done = picked.filter(c => c.group === "done" && !picked.some(o => o !== c && seriesOf(o) === seriesOf(c) && o.ddl > c.ddl));
    const item = (c, sub, kind = "", at = "") => `<li><button type="button" class="rail-item${kind ? " k-" + kind : ""}${c.status !== "confirmed" ? " is-est" : ""}" data-id="${esc(c.id)}"${at ? ` data-at="${at}"` : ""}>
        <span class="r-name">${esc(c.title)} ${esc(c.year)}</span><span class="r-left"></span>
        <span class="r-sub">${sub}</span></button></li>`;
    $("#rail").innerHTML =
      (events.length ? `<div class="rail-group">Upcoming · ${events.length}</div><ul class="rail-list">${events.map(e =>
        item(e.c, `<i class="r-kind">${esc(e.what)}</i> ${esc(e.day || fmtShort.format(e.at))}`, e.kind, e.at)).join("")}</ul>` : "") +
      (done.length ? `<div class="rail-group">Decided · ${done.length}</div><ul class="rail-list">${done.map(c => item(c, esc(c.dec ? "decided " + fmtDay(c.decision) : "closed"))).join("")}</ul>` : "");
    railItems = $$(".rail-item", $("#rail")).map(el => ({ el, c: confs.find(x => x.id === el.dataset.id), at: +el.dataset.at || 0 }));
    tickRail(now);
  }
  function tickRail(now) {
    for (const { el, c, at } of railItems) {
      el.classList.toggle("is-hero", c === heroConf);
      if (!at) { $(".r-left", el).textContent = "✓"; continue; }
      if (at <= now) { renderRail(now); return; } // a date just passed: rebuild the list
      $(".r-left", el).textContent = shortLeft(at - now);
      if (el.classList.contains("k-ddl")) {
        const u = urgency(at - now);
        el.classList.toggle("u-hot", u === "hot");
        el.classList.toggle("u-warn", u === "warn");
      }
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

    refreshPicks(now);
    renderTimeline(visible, now); // it keeps the last three months and the next nine
    renderRail(now);

    if (flipState) {
      Flip.from(flipState, {
        duration: dur(0.45), ease: "power3.inOut", stagger: lite ? 0 : 0.012,
        onEnter: els => gsap.fromTo(els, { opacity: 0, y: 10 }, { opacity: 1, y: 0, clearProps: "transform", duration: 0.4, ease: "power2.out" }),
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
        if (open && animate && hasGsap && fx) {
          gsap.fromTo($$(".card", body).filter(el => el.style.display !== "none").slice(0, 20),
            { opacity: 0, y: 12 }, { opacity: 1, y: 0, clearProps: "transform", duration: 0.4, ease: "power3.out", stagger: 0.02 });
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
    $("#photoNext").addEventListener("click", () => {
      if (!heroConf) return;
      setVenue(heroConf, true);
      if (hasGsap && !reduced) gsap.fromTo("#photoNext svg", { rotate: 0 }, { rotate: 360, duration: 0.6, ease: "power2.out" });
    });

    // the photo ends just inside the timeline section, so the timeline and everything below sit on solid ground
    const sizeBg = () => {
      const t = $(".timeline-wrap").getBoundingClientRect().top + window.scrollY;
      $(".page-bg").style.height = Math.round(t + 70) + "px";
    };
    sizeBg();
    window.addEventListener("resize", sizeBg);
    if (window.ResizeObserver) new ResizeObserver(sizeBg).observe($("#hero"));

    // Mouse light (off by default; the bulb in the top bar turns it on). Only surfaces that are on screen and within
    // LIGHT_RANGE of the cursor get --lx / --ly (cursor position in their own box), so each move repaints just those.
    const LIT = ".topbar, .rail, .controls, .card, .rail-item, .fold-toggle, .digit, .pick, .venue, " +
      ".to-top, .rail-tab, .search, .chip, .btn, .planner-btn, .seg, .icon-btn, .rail-toggle, .photo-next, .tl-pin .lbl";
    const LIGHT_RANGE = 520;
    const light = { on: false, x: -1e4, y: -1e4, queued: false, visible: new Set(), lit: new Set() };
    const io = new IntersectionObserver(entries => {
      for (const en of entries) en.isIntersecting ? light.visible.add(en.target) : light.visible.delete(en.target);
      queueLight();
    }, { rootMargin: "120px" });
    let rescanQueued = false;
    const rescan = () => { rescanQueued = false; $$(LIT).forEach(el => io.observe(el)); };
    // rescan only when elements are added (the per-second countdown text changes don't count)
    const mo = new MutationObserver(list => {
      if (rescanQueued || !list.some(m => [...m.addedNodes].some(n => n.nodeType === 1))) return;
      rescanQueued = true; requestAnimationFrame(rescan);
    });
    const paintLight = () => {
      light.queued = false;
      const near = [];
      for (const el of light.visible) {  // read every box first, then write, so layout is computed once
        if (!el.isConnected) { light.visible.delete(el); continue; }
        const r = el.getBoundingClientRect();
        const dx = Math.max(r.left - light.x, 0, light.x - r.right), dy = Math.max(r.top - light.y, 0, light.y - r.bottom);
        if (dx * dx + dy * dy < LIGHT_RANGE * LIGHT_RANGE) near.push([el, light.x - r.left, light.y - r.top]);
      }
      const now = new Set();
      for (const [el, lx, ly] of near) { el.style.setProperty("--lx", lx + "px"); el.style.setProperty("--ly", ly + "px"); now.add(el); }
      for (const el of light.lit) if (!now.has(el)) { el.style.removeProperty("--lx"); el.style.removeProperty("--ly"); }
      light.lit = now;
    };
    const queueLight = () => { if (light.on && !light.queued && $("#planner").hidden) { light.queued = true; requestAnimationFrame(paintLight); } };
    const setLight = on => {
      light.on = on;
      $("#lightBtn").setAttribute("aria-pressed", on);
      store.set("light", on);
      if (on) { rescan(); mo.observe(document.body, { childList: true, subtree: true }); queueLight(); }
      else { mo.disconnect(); io.disconnect(); light.visible.clear(); for (const el of light.lit) { el.style.removeProperty("--lx"); el.style.removeProperty("--ly"); } light.lit.clear(); }
    };
    if (!reduced && matchMedia("(pointer: fine)").matches) {
      window.addEventListener("pointermove", e => { light.x = e.clientX; light.y = e.clientY; queueLight(); }, { passive: true });
      window.addEventListener("scroll", queueLight, { passive: true });
      document.addEventListener("pointerleave", () => { light.x = light.y = -1e4; queueLight(); });
      $("#lightBtn").addEventListener("click", () => setLight(!light.on));
      setLight(store.get("light", false));
    } else {
      $("#lightBtn").hidden = true;
    }

    // the background photo drifts a little with the mouse
    if (hasGsap && !reduced && matchMedia("(pointer: fine)").matches) {
      const panX = gsap.quickTo("#bgPan", "xPercent", { duration: 1.4, ease: "power3.out" });
      const panY = gsap.quickTo("#bgPan", "yPercent", { duration: 1.4, ease: "power3.out" });
      window.addEventListener("pointermove", e => {
        if (!$("#planner").hidden) return; // the planner covers the page; don't animate what's behind it
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
      const pin = e.target.closest(".tl-pin, .tl-dot, .tl-bare, .tl-chip");
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
      const hop = e.target.closest(".pp-item, .tl-pin");
      if (hop) openPlanner(hop.dataset.id); // chain: plan the next hop from the chosen venue
    });
    $("#planSrc").addEventListener("change", e => openPlanner(e.target.value));
    document.addEventListener("keydown", e => { if (e.key === "Escape") closePlanner(); });
    $("#rail").addEventListener("click", jump);

    // rows fold open to show the details
    document.addEventListener("click", e => {
      const btn = e.target.closest(".row-toggle");
      if (!btn) return;
      const card = btn.closest(".card");
      const more = $(".row-more", card) || buildMore(confs.find(x => x.id === card.dataset.id));
      const open = !card.classList.contains("is-open");
      card.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open);
      if (open) more.hidden = false;
      if (hasGsap && !reduced) {
        gsap.fromTo(more, { height: open ? 0 : more.offsetHeight, opacity: open ? 0 : 1 },
          { height: open ? "auto" : 0, opacity: open ? 1 : 0, duration: lite ? 0.18 : 0.3, ease: "power2.out",
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
      if (hasGsap && fx) gsap.fromTo(c.refs.bar, { width: "0%" }, { width: w, duration: 1.4, ease: "expo.out" });
      else c.refs.bar.style.width = w;
    };
    if (!hasGsap || !fx || !window.ScrollTrigger) { list.forEach(c => { c.revealed = true; growBar(c); }); return; }
    gsap.set(list.map(c => c.el), { opacity: 0, y: 14 });
    ScrollTrigger.batch(list.map(c => c.el), {
      start: "top 92%", once: true,
      onEnter: els => {
        // skip rows a filter change already revealed, so this never fights a running Flip
        const fresh = els.map(el => list.find(x => x.el === el)).filter(c => c && !c.revealed);
        if (!fresh.length) return;
        fresh.forEach(c => { c.revealed = true; growBar(c); });
        gsap.to(fresh.map(c => c.el), { opacity: 1, y: 0, clearProps: "transform", duration: 0.6, ease: "expo.out", stagger: 0.035 });
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
    for (const c of confs) if (c.onscreen) tickCard(c, now); // off-screen rows catch up when they scroll in
  }
  // which rows are on screen, so the per-second tick only touches those
  const cardIO = new IntersectionObserver(entries => {
    for (const en of entries) {
      const c = en.target.conf;
      c.onscreen = en.isIntersecting;
      if (c.onscreen) tickCard(c, Date.now());
    }
  }, { rootMargin: "200px" });

  // sw.js keeps photos, fonts and GSAP on the device after the first download
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  async function init() {
    bind();
    tickNow(Date.now());
    try {
      const res = await fetch(`data/conferences.json?v=${BUILD}`);
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
    // (skipped while the tab is hidden; it catches up as soon as it is shown again)
    setTimeout(() => { tick(); setInterval(() => { if (!document.hidden) tick(); }, 1000); }, 1000 - (Date.now() % 1000));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }

  init();
})();
