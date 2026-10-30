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

  // Build id from our own script URL (?v=<commit> on the live site, "dev" locally). Data URLs carry it too, so they
  // match the <link rel="preload"> in index.html and every deploy busts the browser cache.
  const BUILD = (document.currentScript && new URL(document.currentScript.src).searchParams.get("v")) || "dev";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const store = {
    get(k, d) { try { const v = localStorage.getItem("confddl:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("confddl:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const RANKS = ["gradeA", "gradeB", "ccfA", "ccfB"];
  const state = {
    q: "",
    areas: new Set(store.get("areas", [])),
    onlyConfirmed: store.get("onlyConfirmed", false),
    // the timeline as an axis or a list of months (phones start with the list, which reads better that narrow)
    tlView: store.get("tlView", matchMedia("(max-width: 560px)").matches ? "list" : "axis") === "list" ? "list" : "axis",
    // rank filters (gradeA, gradeB, ccfA, ccfB): a conference shows if it matches any one that is on
    ranks: new Set(RANKS.filter(k => store.get(k, false))),
    onlyStarred: store.get("onlyStarred", false), // the "★ Mine" scope above the list
    tab: store.get("listTab", "up"), // Upcoming / In review / Decided: one tab on show at a time
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
  // a rebuttal's closing moment, short enough for a row: "10/31 23:59" in the reader's zone (or AoE)
  const fmtCloseLocal = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const fmtCloseAoE = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Etc/GMT+12" });
  const fmtClose = ms => (state.tz === "aoe" ? fmtCloseAoE.format(ms) + " AoE" : fmtCloseLocal.format(ms));
  // when a rebuttal closes: the announced moment in the reader's zone, or the last day with its time still unannounced
  const rebClose = c => c.rebExact ? fmtTime(c.reb[1]) : `${fmtDay(c.rebuttal[1], true)} (time not announced)`;
  // under the rebuttal's days in a row: the exact closing moment, when the venue gave one
  const paintRebAt = c => {
    const li = $$(".c-steps li", c.el)[1];
    let at = $(".reb-at", li);
    if (!c.rebExact) { at?.remove(); return; }
    if (!at) { at = document.createElement("small"); at.className = "reb-at"; li.append(at); }
    at.textContent = `→ ${fmtClose(c.reb[1])}`;
    li.title = `${fmtRange(c.rebuttal, true)} · closes ${rebClose(c)}`;
  };

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
    if (state.ranks.size && ![...state.ranks].some(k => (k.startsWith("ccf") ? c.ccf : gradeOf(c)) === k.slice(-1))) return false;
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
    saveIcs(`${c.id}.ics`, lines.join("\r\n"));
  }

  function saveIcs(name, text) {
    const blob = new Blob([text], { type: "text/calendar" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
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
    setStep(steps[1], c.rebuttal ? fmtRange(c.rebuttal) : (c.rebuttal === false ? "none" : "TBA"), c.rebuttal ? `${fmtRange(c.rebuttal, true)} · closes ${rebClose(c)}` : "");
    setStep(steps[2], c.decision ? fmtDay(c.decision) : "TBA", c.decision ? fmtDay(c.decision, true) : "");
    c.el = el;
    el.conf = c;
    if (c.rebExact) paintRebAt(c);
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
    const known = cityLinks(cityPhotos[venueOf(c.place).key], false);
    if (known) $(".c-known", more).innerHTML = known; else $(".c-city", more).remove();
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
      if (c.rebExact && c.el) paintRebAt(c);
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
        when: opens ? `Rebuttal ${fmtRange(c.rebuttal, true)} · closes ${rebClose(c)}` : `Rebuttal closes ${rebClose(c)}` };
    }
    return c.dec && c.dec > now ? { at: c.dec, kind: "Next decision", when: "Decision " + fmtDay(c.decision, true) } : null;
  }

  function pickFor(mode, now) {
    const filtered = state.areas.size || state.onlyConfirmed || state.ranks.size || state.q || state.onlyStarred;
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
      if (ev) { p = { ...ev, c, mode: "manual", scope: state.manualScope || "from timeline" }; mode = "manual"; }
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
      $("#heroShare").hidden = !p;
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
  // "*" is every photo in the database: the backdrop for an entry whose venue has none (TBA, online, not fetched yet)
  let allPhotos = null;
  const photosOf = city => {
    if (city === "*") return (allPhotos ||= Object.entries(cityPhotos).flatMap(([k, e]) =>
      (e.photos || (e.src ? [e] : [])).map(ph => ({ ...ph, from: k }))));
    const entry = cityPhotos[city];
    return entry ? (entry.photos || (entry.src ? [entry] : [])) : [];
  };
  function pickCityPhoto(city, advance) {
    const list = photosOf(city);
    if (!list.length) return null;
    let i = advance && city !== "*" && lastPhoto[city] != null ? lastPhoto[city] + 1 : Math.floor(Math.random() * list.length);
    if (!advance && list.length > 1 && i === lastPhoto[city]) i += 1;
    i %= list.length;
    lastPhoto[city] = i;
    // ask the CDN for a size that fits the screen (≈300–400 KB as AVIF/WebP instead of ~1 MB)
    const w = innerWidth > 1800 ? 2000 : innerWidth > 900 ? 1600 : 1000;
    return { ...list[i], src: list[i].src.replace(/([?&])w=\d+/, `$1w=${w}`).replace(/([?&])q=\d+/, "$1q=70") };
  }

  // ---------- the venue's own clock and sky ----------
  // The sun's height (degrees) at a place and moment, after SunCalc (Vladimir Agafonkin, BSD); rising = before noon.
  function sunAt(lat, lon, t) {
    const rad = Math.PI / 180, d = t / 864e5 - 10957.5; // days since J2000.0
    const M = rad * (357.5291 + 0.98560028 * d);
    const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
    const e = rad * 23.4397, dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const H = rad * (280.16 + 360.9856235 * d) + rad * lon - ra, phi = rad * lat;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / rad;
    return { alt, rising: Math.sin(H) < 0 };
  }
  // night below -8° (about 40 minutes before sunrise or after sunset); dawn and dusk until the sun is 10° up
  const PHASES = ["dawn", "day", "dusk", "night"];
  const phaseAt = (entry, t) => {
    const { alt, rising } = sunAt(entry.lat, entry.lon, t);
    return alt < -8 ? "night" : alt < 10 ? (rising ? "dawn" : "dusk") : "day";
  };
  // the backdrop follows the reader's own clock, in step with the light / dark theme (light 6–18)
  const localPhase = () => { const h = new Date().getHours(); return h >= 5 && h < 7 ? "dawn" : h >= 7 && h < 17 ? "day" : h >= 17 && h < 19 ? "dusk" : "night"; };
  // the closest mood when a city lacks the one asked for
  const NEAR = { dawn: ["dawn", "dusk", "day", "night"], day: ["day", "dawn", "dusk", "night"],
    dusk: ["dusk", "dawn", "night", "day"], night: ["night", "dusk", "dawn", "day"] };
  const localClock = tz => { try { return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date()); } catch { return ""; } };

  // The list page wears the same picture as a wash of colour: drawn 48 px wide and stretched back up, which blurs it
  // for free (a CSS blur filter that size made the page switch stutter)
  function listGround(src) {
    const cv = $("#listBgImg"), ctx = cv.getContext("2d");
    if (!src) { ctx.clearRect(0, 0, cv.width, cv.height); return; }
    const img = new Image();
    img.onload = () => {
      const r = Math.max(cv.width / img.naturalWidth, cv.height / img.naturalHeight), w = img.naturalWidth * r, h = img.naturalHeight * r;
      ctx.imageSmoothingQuality = "high";
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, (cv.width - w) / 2, (cv.height - h) * .4, w, h);
      // fade it out downwards here rather than with a CSS mask, which had to be redrawn on every frame of the switch
      const fade = ctx.createLinearGradient(0, 0, 0, cv.height);
      fade.addColorStop(0, "#000"); fade.addColorStop(.45, "rgb(0 0 0 / .55)"); fade.addColorStop(.85, "transparent");
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, cv.width, cv.height);
    };
    img.src = src;
  }

  // the backdrop cross-fades: the new picture fades in over the old, which leaves once it is covered
  function showBackdrop(src, cls = "") {
    const pan = $("#bgPan"), old = $$(".page-bg-img", pan);
    listGround(src);
    if (!src) { old.forEach(o => o.classList.remove("is-loaded")); return; }
    const el = document.createElement("div");
    el.className = `page-bg-img ${cls}`;
    el.style.backgroundImage = `url("${src}")`;
    pan.append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-loaded")));
    setTimeout(() => old.forEach(o => o.remove()), 1300);
  }

  async function setVenue(c, advance = false) {
    const fig = $("#venue"), credit = $("#venueCredit");
    const { city, country, key, virtual } = venueOf(c && c.place);
    const place = key;
    const same = fig.dataset.key === place;
    fig.dataset.key = place;
    if (!same) delete fig.dataset.scene; // a scene picked by hand belongs to its city
    fig.classList.toggle("is-tba", !place);
    // only the country known ("Japan (TBA)" or "TBA, Japan"): show the country, file the photo under it
    $("#venueCity").textContent = !place ? (virtual ? "Online" : "Venue to be announced") : city || COUNTRY_NAMES[country] || country;
    $("#venueCountry").textContent = city ? country : place ? "city TBA" : "";
    $("#venueDates").textContent = c ? c.date || "" : "";
    const token = (fig.dataset.token = String(Math.random()));
    await loadCityPhotos;
    if (fig.dataset.token !== token) return;
    const entry = place ? cityPhotos[key] : null;
    venueSky(entry);
    venueLinks(entry);
    updateWeather(entry);

    // generated panoramas in the mood of the venue's local time; the ↻ button steps through the moods
    const scenes = entry && entry.scenes && PHASES.filter(p => entry.scenes[p]);
    let shown;
    if (scenes && scenes.length) {
      const now = localPhase();
      let pick = advance ? PHASES[(PHASES.indexOf(fig.dataset.scene || now) + 1) % 4] : fig.dataset.scene || now;
      if (advance) while (!entry.scenes[pick]) pick = PHASES[(PHASES.indexOf(pick) + 1) % 4];
      pick = NEAR[pick].find(p => entry.scenes[p]);
      if (advance) fig.dataset.scene = pick;
      fig.dataset.shown = pick;
      shown = { src: entry.scenes[pick], cls: "is-pano", credit: `${pick[0].toUpperCase() + pick.slice(1)} in ${esc(city || COUNTRY_NAMES[country] || country)} · AI-generated scene` };
    } else {
      delete fig.dataset.shown;
      const pool = place && photosOf(key).length ? key : "*";
      const un = pickCityPhoto(pool, advance);
      if (un) shown = { src: un.src, credit: (un.from ? `${esc(un.from)} · ` : "") + `Photo by <a href="${esc(un.photographer_url)}" target="_blank" rel="noopener">${esc(un.photographer)}</a>` +
        ` on <a href="${esc(un.photo_url)}" target="_blank" rel="noopener">Unsplash</a>` };
    }
    if (!shown) { credit.hidden = true; showBackdrop(null); return; }
    const pre = new Image();
    pre.crossOrigin = "anonymous"; // matches how the service worker fetches, so both share one cached copy
    pre.onload = () => {
      if (fig.dataset.token !== token) return;
      showBackdrop(shown.src, shown.cls);
      $(".page-bg").dataset.mood = fig.dataset.shown || "photo"; // the light theme's veil thins over daylight only
      credit.innerHTML = shown.credit;
      credit.hidden = false;
    };
    pre.src = shown.src;
  }

  // "18:42 local · dusk" under the venue's name
  function venueSky(entry) {
    const el = $("#venueLocal");
    if (!entry || !entry.tz) { el.hidden = true; return; }
    const phase = entry.lat != null ? phaseAt(entry, Date.now()) : "";
    const wx = venueWx && WX_TEXT[venueWx.weather_code];
    const temp = venueWx && venueWx.temperature_2m != null ? (/-US$/.test(navigator.language) ?
      `${Math.round(venueWx.temperature_2m * 9 / 5 + 32)}°F` : `${Math.round(venueWx.temperature_2m)}°C`) : "";
    el.innerHTML = `<b>${esc(localClock(entry.tz))}</b> local${phase ? ` · <i class="sky sky-${phase}"></i>${phase}` : ""}` +
      (wx ? ` · ${esc(wx)}${temp ? ` ${temp}` : ""}` : "");
    el.hidden = false;
  }
  // what the place is known for, each linked to its own official site, and the official visitor site
  function cityLinks(entry, label = true) {
    const famous = (entry && entry.famous) || [], visit = entry && entry.tourism;
    if (!famous.length && !visit) return "";
    const link = (href, text, cls = "") => `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
    return (famous.length ? (label ? `<span class="vl-k">Known for</span> ` : "") +
      famous.map(f => (f.url ? link(f.url, esc(f.name)) : `<span>${esc(f.name)}</span>`)).join(`<span class="vl-sep">·</span>`) : "") +
      (visit ? link(visit, "Official visitor site ↗", "vl-visit") : "");
  }
  function venueLinks(entry) {
    const el = $("#venueLinks"), html = cityLinks(entry);
    el.innerHTML = html;
    el.hidden = !html;
  }
  // ---------- the venue's weather (Open-Meteo, no key), drawn over the backdrop ----------
  // WMO weather codes → what to draw, how hard, and how to say it
  const WX_TEXT = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "showers", 81: "showers", 82: "heavy showers",
    85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail" };
  const WX_DRAW = { 45: ["fog", .7], 48: ["fog", .9], 51: ["rain", .2], 53: ["rain", .3], 55: ["rain", .4], 56: ["rain", .3], 57: ["rain", .4],
    61: ["rain", .45], 63: ["rain", .7], 65: ["rain", 1], 66: ["rain", .5], 67: ["rain", .8], 71: ["snow", .4], 73: ["snow", .7],
    75: ["snow", 1], 77: ["snow", .3], 80: ["rain", .6], 81: ["rain", .8], 82: ["rain", 1], 85: ["snow", .6], 86: ["snow", 1],
    95: ["storm", 1], 96: ["storm", 1], 99: ["storm", 1] };
  const wxCache = {};
  async function weatherOf(entry) {
    const k = `${entry.lat},${entry.lon}`, hit = wxCache[k];
    if (hit && Date.now() - hit.at < 15 * 60e3) return hit.now;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${entry.lat}&longitude=${entry.lon}` +
      "&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&timezone=auto",
      window.AbortSignal && AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {});
    if (!r.ok) throw new Error(r.status);
    const now = (await r.json()).current;
    wxCache[k] = { at: Date.now(), now };
    return now;
  }
  // ?weather=rain|snow|fog|storm previews a kind of weather whatever the venue's sky
  const wxPreview = new URLSearchParams(location.search).get("weather");
  let venueWx = null; // the venue's current conditions, for the line under its name
  async function updateWeather(entry) {
    const token = $("#venue").dataset.token;
    let kind = null, level = 0, wind = 0;
    venueWx = null;
    const preview = { rain: "rain", snow: "snow", fog: "fog", storm: "storm" }[wxPreview];
    if (preview) weather.set(preview, 1, .3); // don't wait for the network to show a preview
    if (entry && entry.lat != null) {
      try {
        const now = await weatherOf(entry);
        if ($("#venue").dataset.token !== token) return;
        venueWx = now;
        [kind, level] = WX_DRAW[now.weather_code] || [null, 0];
        // wind blowing from the east pushes the rain to the left; ~60 km/h leans it about 30°
        wind = -Math.sin((now.wind_direction_10m || 0) * Math.PI / 180) * Math.min(1, (now.wind_speed_10m || 0) / 60);
      } catch { /* no weather: just no drawing */ }
    }
    if (preview) [kind, level, wind] = [preview, 1, .3];
    venueSky(entry);
    weather.set(kind, level, wind);
  }

  // rain streaks, drifting snow or rolling fog on a canvas over the photo; it sleeps when nobody can see it
  const weather = (() => {
    const cv = $("#wx"), ctx = cv && cv.getContext("2d");
    let kind = null, level = 0, wind = 0, parts = [], raf = 0, W = 0, H = 0, flash = 0, last = 0;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const dark = () => document.documentElement.dataset.theme === "dark" ||
      (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    const visible = () => kind && !document.hidden && document.body.dataset.page !== "list" && $("#planner").hidden;
    function size() {
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function seed() {
      const area = W * H, rnd = Math.random;
      if (kind === "rain" || kind === "storm") {
        parts = Array.from({ length: Math.min(420, Math.round(level * area / 5200)) }, () =>
          ({ x: rnd() * W, y: rnd() * H, len: 10 + rnd() * 16, v: 700 + rnd() * 500, a: .25 + rnd() * .35 }));
      } else if (kind === "snow") {
        parts = Array.from({ length: Math.min(260, Math.round(level * area / 7000)) }, () =>
          ({ x: rnd() * W, y: rnd() * H, r: .8 + rnd() * 2.4, v: 25 + rnd() * 45, ph: rnd() * 6.3, a: .5 + rnd() * .45 }));
      } else if (kind === "fog") {
        parts = Array.from({ length: 7 }, (_, i) =>
          ({ x: rnd() * W, y: H * (.35 + rnd() * .55), r: W * (.25 + rnd() * .3), v: (8 + rnd() * 14) * (i % 2 ? 1 : -1) }));
      } else parts = [];
    }
    function draw(dt) {
      ctx.clearRect(0, 0, W, H);
      const ink = dark() ? "255, 255, 255" : "70, 90, 120";
      if (kind === "rain" || kind === "storm") {
        const lean = wind * .6;
        ctx.lineWidth = 1; ctx.lineCap = "round";
        for (const p of parts) {
          p.y += p.v * dt; p.x += p.v * lean * dt;
          if (p.y > H) { p.y = -p.len; p.x = Math.random() * (W + 200) - 100; }
          ctx.strokeStyle = `rgba(${ink}, ${p.a})`;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - lean * p.len, p.y - p.len); ctx.stroke();
        }
        if (kind === "storm") {
          if (flash < .02 && Math.random() < dt * .12) flash = 1; // a flash every ~8 s on average
          if (flash > .02) { ctx.fillStyle = `rgba(235, 240, 255, ${flash * .28})`; ctx.fillRect(0, 0, W, H); flash *= Math.pow(.02, dt); }
        }
      } else if (kind === "snow") {
        ctx.fillStyle = `rgba(${dark() ? "255, 255, 255" : "255, 255, 255"}, .9)`;
        for (const p of parts) {
          p.ph += dt; p.y += p.v * dt; p.x += (Math.sin(p.ph) * 12 + wind * 40) * dt;
          if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
          if (p.x > W + 4) p.x = -4; else if (p.x < -4) p.x = W + 4;
          ctx.globalAlpha = p.a;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (kind === "fog") {
        const c = dark() ? "190, 200, 215" : "245, 247, 250";
        ctx.fillStyle = `rgba(${c}, ${.04 * level})`; ctx.fillRect(0, 0, W, H);
        for (const p of parts) {
          p.x += p.v * dt;
          if (p.x - p.r > W) p.x = -p.r; else if (p.x + p.r < 0) p.x = W + p.r;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, `rgba(${c}, ${.16 * level})`); g.addColorStop(1, `rgba(${c}, 0)`);
          ctx.fillStyle = g; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        }
      }
    }
    function frame(t) {
      raf = 0;
      if (!visible()) return;
      const dt = Math.min(.05, last ? (t - last) / 1000 : 0);
      last = t;
      draw(dt);
      raf = requestAnimationFrame(frame);
    }
    function wake() {
      if (!cv) return;
      if (!kind) { cancelAnimationFrame(raf); raf = 0; ctx.clearRect(0, 0, W, H); return; }
      if (reduced) { draw(0); return; } // one still frame, no motion
      if (visible() && !raf) { last = 0; raf = requestAnimationFrame(frame); }
    }
    if (cv) {
      new ResizeObserver(() => { size(); seed(); if (reduced || !raf) kind && draw(0); }).observe(cv);
      document.addEventListener("visibilitychange", wake);
      new MutationObserver(wake).observe(document.body, { attributes: true, attributeFilter: ["data-page"] });
      new MutationObserver(wake).observe($("#planner"), { attributes: true, attributeFilter: ["hidden"] });
    }
    return {
      set(k, l, w) {
        const changed = k !== kind || Math.abs(l - level) > .05;
        kind = k; level = l; wind = w;
        if (!cv) return;
        if (changed) { size(); seed(); }
        cv.classList.toggle("is-on", !!kind);
        wake();
      },
    };
  })();

  // every half minute: the venue's clock, and its sky once the mood there changes
  setInterval(() => {
    if (document.hidden || !heroConf) return;
    const fig = $("#venue"), entry = cityPhotos[fig.dataset.key];
    if (!entry || entry.lat == null) return;
    venueSky(entry);
    updateWeather(entry); // cached for 15 minutes, so this asks the network only now and then
    const phase = localPhase();
    if (fig.dataset.shown && !fig.dataset.scene && NEAR[phase].find(p => entry.scenes[p]) !== fig.dataset.shown) setVenue(heroConf);
  }, 30000);

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
      hero.classList.add("is-empty");
      return;
    }
    hero.classList.remove("is-empty");
    const chars = splitChars($("#heroName"), c.title);
    $("#heroYear").textContent = c.year;
    $("#heroFull").textContent = c.full_name + (c.status !== "confirmed" ? " · estimated date" : "");
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

  let timelineList = [], tlStale = false;
  let tlVertical = matchMedia("(max-width: 640px)").matches;

  // The month list scrolls; once this month is out of sight, a "Today" button takes the reader back.
  let tlAnchor = null; // {m, dy}: the month at the top of the list once the reader scrolls it themselves
  function tlToday(tl, smooth = true) {
    tlAnchor = null;
    // phones open at today itself, past this month's passed dates; wider screens show the whole month
    const mark = innerWidth <= 560 && $(".tl-mtoday", tl);
    const row = $(".tl-mrow.is-now", tl), box = $(".tl-months", tl);
    if (row && box) box.scrollTo({ top: mark ? mark.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 4 : row.offsetTop - box.offsetTop - 8, behavior: smooth && !reduced ? "smooth" : "auto" });
  }
  function watchToday(tl) {
    const row = $(".tl-mrow.is-now", tl), box = $(".tl-months", tl), btn = $(".tl-back", tl);
    if (!row || !box || !btn) return;
    const check = () => {
      const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
      const off = r.bottom < b.top + 12 ? "up" : r.top > b.bottom - 28 ? "down" : "";
      btn.hidden = !off;
      btn.dataset.dir = off;
    };
    let touched = 0; // scrolls soon after the reader's own wheel, touch or drag are theirs
    for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) box.addEventListener(ev, () => { touched = Date.now(); }, { passive: true });
    box.addEventListener("scroll", () => {
      check();
      if (Date.now() - touched > 1500) return;
      const top = box.getBoundingClientRect().top, rows = $$(".tl-mrow", box);
      const r = rows.find(x => x.getBoundingClientRect().bottom > top + 1) || rows[0];
      tlAnchor = { m: r.dataset.m, dy: top - r.getBoundingClientRect().top };
    }, { passive: true });
    btn.addEventListener("click", () => tlToday(tl));
    requestAnimationFrame(check);
  }

  // Home timeline by default; the planner passes its own element and asks for the resubmission path.
  function renderTimeline(list, now, opts = {}) {
    if (!opts.el) scheduleFit(); // the strip can grow a row (a picked conference adds its dates)
    const tl = opts.el || $("#timeline");
    if (!opts.el) {
      timelineList = list;
      tlStale = !tl.offsetParent; // folded away: drawn once it is shown (fitNow)
      if (tlStale) return;
    }
    // the span shown: the past three months and the next nine (the planner from the start of that first month)
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    if (opts.el) start.setDate(1);
    start.setMonth(start.getMonth() - 3);
    const end = new Date(start); end.setMonth(end.getMonth() + (opts.el ? 13 : 12));
    const span = end - start;
    const x = ms => ((ms - start) / span) * 100;
    // month boundaries inside the span
    const bounds = [];
    for (const m = new Date(start.getFullYear(), start.getMonth() + 1, 1); +m < +end; m.setMonth(m.getMonth() + 1)) bounds.push(new Date(m));
    const monthName = m => m.toLocaleString(undefined, { month: "short" }) + (m.getMonth() === 0 ? ` ’${String(m.getFullYear()).slice(2)}` : "");
    const asList = !opts.el && state.tlView === "list";

    let html = `<div class="timeline-inner"><div class="tl-axis"></div>`;
    bounds.forEach(m => { // no labels on the edges, they would be clipped
      if (x(+m) > 2 && x(+m) < 98) html += `<span class="tl-month" style="left:${x(+m)}%">${esc(monthName(m))}</span>`;
    });
    html += `<div class="tl-past" style="width:${x(now)}%"></div><div class="tl-today" style="left:${x(now)}%"></div>`;

    // Labels hang to the right of their pin; stack them on rows so none overlap.
    // phones scroll a wider strip sideways (see style.css); the label budget keeps the height fixed
    const narrow = tlVertical; // a list of months instead of the strip: set by the countdown page's layout (fitNow)
    const W = Math.max(tl.clientWidth, 720), MAXROW = 3; // 3 rows of names; a clicked conference adds a 4th for its dates
    // one labelled block per conference, at its deadline; a conference in review also gets a small dot on the
    // axis at its next date — amber for rebuttal (when it opens, or closes once open), green for the decision
    const next = c => {
      if (c.ddl > now) return null;
      if (c.reb && now < c.reb[1]) return { at: now < c.reb[0] ? c.reb[0] : c.reb[1], ev: "reb" };
      if (c.dec && now < c.dec) return { at: c.dec, ev: "dec" };
      return null;
    };
    // The home timeline follows a conference only once the reader taps one (or opens it from a card or a link);
    // until then every conference is shown alike.
    const lightId = opts.el ? null : state.lightId;
    // the followed conference also gets its other dates as blocks of their own, labelled with the date
    const sel = lightId && list.find(c => c.id === lightId);
    const extra = !sel ? [] : [
      null,
      sel.reb && { c: sel, at: sel.reb[0], ev: "reb", text: `Rebuttal ${fmtRange(sel.rebuttal)}` },
      sel.dec && { c: sel, at: sel.dec, ev: "dec", text: `Decision ${fmtDay(sel.decision)}` },
    ].slice(1).filter(Boolean);
    const events = [...list.map(c => ({ c, at: c.ddl, ev: "ddl" })), ...extra].filter(e => e.at >= +start && e.at < +end).sort((a, b) => a.at - b.at);
    const path = opts.path && state.pathId ? resubmitPath(confs.find(c => c.id === state.pathId), now) : null;
    // home timeline: a clicked conference lights up where its paper could go next (no arcs, no panel)
    const glow = lightId ? resubmitPath(confs.find(c => c.id === lightId), now) : null;
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
    const rank = e => (e.text || e.c.id === lightId ? 1e4 : 0) + (lit && role(e.c) && !role(e.c).includes("dim") ? 2000 : 0)
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
    // The home axis, kept quiet: grey beads on a line from today on, deadlines a few days apart merge into one
    // bead with a count, and only the best-placed names get a label (two rows at most). The one colour is the
    // accent, for today and the next deadline; a tapped conference adds its reviews and lights its next venues.
    const upcoming = list.filter(c => c.ddl > now).sort((a, b) => a.ddl - b.ddl)[0]; // the one accent
    function quietAxis() {
      const W = Math.max(tl.clientWidth, 560), GAP = 30, ROW = 21, ROWS = 2;
      // merge the closest pair of neighbours until every bead has room of its own
      let beads = events.filter(e => !e.text).map(e => ({ items: [e], px: x(e.at) }));
      for (;;) {
        let k = -1, best = GAP;
        for (let i = 1; i < beads.length; i++) {
          const d = ((beads[i].px - beads[i - 1].px) / 100) * W;
          if (d < best) { best = d; k = i; }
        }
        if (k === -1) break;
        const items = [...beads[k - 1].items, ...beads[k].items];
        beads.splice(k - 1, 2, { items, px: items.reduce((t, e) => t + x(e.at), 0) / items.length });
      }
      beads.forEach(b => {
        b.items.sort((p, q) => rank(q) - rank(p));
        b.top = b.items[0];
        const n = b.items.length, c = b.top.c;
        b.label = `${isStarred(c) ? "★ " : ""}${c.title} ${String(c.year).slice(2)}${n > 1 ? ` +${n - 1}` : ""}`;
      });
      const dated = events.filter(e => e.text).map(e => ({ a: (x(e.at) / 100) * W, px: x(e.at), items: [e], top: e, label: e.text }));
      // labels go to the most useful beads first; each hangs right of its bead (left near the right edge)
      const rows = Array.from({ length: ROWS }, () => []);
      [...beads].sort((p, q) => rank(q.top) - rank(p.top)).forEach(b => {
        const lw = b.label.length * 8 + 12, at = (b.px / 100) * W;
        b.flip = at + lw > W - 4;
        const l = b.flip ? at - lw : at - 4, r = l + lw + 10;
        b.row = rows.findIndex(R => R.every(([L, RR]) => r < L || l > RR));
        if (b.row !== -1) rows[b.row].push([l, r]);
      });
      let used = Math.max(1, rows.filter(R => R.length).length);
      dated.forEach(d => { d.row = used; d.flip = d.top.ev === "reb" && (d.px / 100) * W - d.label.length * 8 > 0; });
      if (dated.length) used += 1;
      const axis = 6 + used * ROW + 14;
      tl.style.setProperty("--axis", axis + "px");
      let h = `<div class="timeline-inner tlx"><div class="tlx-axis"></div>`;
      bounds.forEach(m => {
        if (x(+m) < 97 && ((x(+m) - x(now)) / 100) * W > 56) h += `<span class="tlx-month" style="left:${x(+m)}%">${esc(monthName(m))}</span>`;
      });
      h += `<div class="tlx-today" style="left:${x(now)}%"></div>`;
      [...beads, ...dated].forEach(b => {
        const { c, ev } = b.top, n = b.items.length;
        const cls = [
          ev !== "ddl" && `ev-${ev}`,
          b.items.every(e => e.c.status !== "confirmed") && ev === "ddl" && "est",
          b.items.every(e => e.at <= now) && "past",
          b.items.some(e => e.c === upcoming && e.ev === "ddl") && !lit && "next",
          ({ A: "g-a", B: "g-b" })[gradeOf(c)],
          n > 1 && "many",
        ].filter(Boolean).join(" ") + role(c);
        const tip = b.items.map(e => e.text ? `${e.c.title} ${e.text}` : tipOf(e.c)).join("\n");
        const top = b.row === -1 ? axis : 6 + b.row * ROW;
        const ids = n > 1 ? ` data-ids="${esc(b.items.map(e => e.c.id).join(" "))}"` : ` data-id="${esc(c.id)}"`;
        h += `<button type="button" class="tlx-pin ${cls}${b.flip ? " flip" : ""}"${ids} style="left:${b.px}%;top:${top}px;height:${axis - top}px" title="${esc(tip)}" aria-label="${esc(tip)}">` +
          (b.row === -1 ? "" : `<span class="lbl">${esc(b.label)}</span><span class="stem"></span>`) +
          `<span class="dot">${n > 1 ? n : ""}</span></button>`;
      });
      return h + `</div>`;
    }
    // the month list (chosen with the Axis / Months switch): the same dates, one row per month
    if (asList) {
      const items = events;
      const first = new Date(start); first.setDate(1); first.setHours(0, 0, 0, 0);
      const months = [];
      for (const m = new Date(first); +m < +end; m.setMonth(m.getMonth() + 1)) months.push({ m: new Date(m), items: [] });
      items.forEach(e => {
        const d = new Date(e.at), i = (d.getFullYear() - first.getFullYear()) * 12 + d.getMonth() - first.getMonth();
        if (months[i]) months[i].items.push(e);
      });
      const thisMonth = new Date(now).getMonth(), thisYear = new Date(now).getFullYear();
      html = `<div class="tl-months">` + months.map(({ m, items }) => {
        const isNow = m.getMonth() === thisMonth && m.getFullYear() === thisYear, isPast = !isNow && +m < now;
        const name = m.toLocaleString(undefined, { month: "short" }), yr = m.getMonth() === 0 || isNow ? ` ’${String(m.getFullYear()).slice(2)}` : "";
        const sorted = items.sort((a, b) => a.at - b.at), cut = isNow ? (i => i < 0 ? sorted.length : i)(sorted.findIndex(e => e.at > now)) : -1;
        const chips = sorted.map((e, i) => {
          const cls = `tl-chip ev-${e.ev}${e.ev === "ddl" && e.c.status !== "confirmed" ? " est" : ""}${e.at <= now ? " past" : ""}${role(e.c)}`;
          const text = e.text || `${e.c.title} ${String(e.c.year).slice(2)}`;
          return (i === cut && i > 0 ? `<i class="tl-mtoday"><span>Today</span></i>` : "") + `<button type="button" class="${cls}" data-id="${esc(e.c.id)}" title="${esc(tipOf(e.c))}">${esc(text)}${e.text ? "" : `<small>${new Date(e.at).getDate()}</small>`}</button>`;
        }).join("") + (cut > 0 && cut === sorted.length ? `<i class="tl-mtoday"><span>Today</span></i>` : "");
        return `<div class="tl-mrow${isNow ? " is-now" : ""}${isPast ? " is-past" : ""}" data-m="${m.getFullYear()}-${m.getMonth()}"><span class="tl-mname">${esc(name)}<small>${esc(yr)}</small></span><div class="tl-mchips">${chips || `<span class="tl-mempty">—</span>`}</div></div>`;
      }).join("") + `</div>`;
      tl.innerHTML = html + `<button type="button" class="tl-back" hidden><i></i>Today</button>`;
      // a re-render keeps the month the reader scrolled to; otherwise the list opens on this month
      const back = opts.quiet && tlAnchor && $(`.tl-mrow[data-m="${tlAnchor.m}"]`, tl), box = $(".tl-months", tl);
      if (back) box.scrollTop = back.offsetTop - box.offsetTop + tlAnchor.dy;
      else tlToday(tl, false);
      watchToday(tl);
      tl.classList.remove("is-vert");
      tl.classList.add("is-list");
    // tall boxes (the countdown page in two columns, or in portrait): the same axis, standing up.
    // Time runs down a line on the left, names hang to its right in up to four lanes; the rest stay bare dots.
    } else if (narrow && !opts.el) {
      const H = Math.max(tl.clientHeight, 110), Wd = Math.max(tl.clientWidth, 220);
      const AX = 46, PAD = 12, SLOT = 22;
      const y = ms => PAD + ((ms - start) / span) * (H - 2 * PAD);
      const lanes = Math.max(1, Math.min(4, Math.floor((Wd - AX - 14) / 118)));
      const laneW = (Wd - AX - 14) / lanes;
      const nowM = new Date(now);
      const gap = (H - 2 * PAD) * (30.4 * DAY) / span; // pixels per month
      let v = `<div class="tlv" style="height:${H}px"><div class="tlv-past" style="height:${y(now)}px"></div><div class="tlv-axis" style="left:${AX}px"></div>`;
      bounds.forEach(m => { v += `<i class="tlv-tick" style="top:${y(+m)}px;left:${AX - 5}px"></i>`; });
      // each month is named at the middle of the part of it that shows
      const segs = [new Date(start), ...bounds].map((m, i, all) => ({ m, a: +m, b: i + 1 < all.length ? +all[i + 1] : +end }));
      segs.forEach(({ m, a, b }, i) => {
        if (y(b) - y(a) < 11) return; // a sliver at the edge
        const isNow = m.getMonth() === nowM.getMonth() && m.getFullYear() === nowM.getFullYear();
        // a short box names every other month (always this one and January)
        if (gap < 15 && !isNow && m.getMonth() !== 0 && i % 2 === 0) return;
        const label = m.toLocaleString(undefined, { month: "short" }) + (m.getMonth() === 0 || isNow ? ` ’${String(m.getFullYear()).slice(2)}` : "");
        v += `<span class="tlv-month${isNow ? " is-now" : ""}" style="top:${(y(a) + y(b)) / 2}px;width:${AX - 10}px">${esc(label)}</span>`;
      });
      v += `<div class="tlv-today" style="top:${y(now)}px;left:${AX}px"><span>today</span></div>`;
      const used = Array.from({ length: lanes }, () => []);
      const placed = [...events].sort((p, q) => rank(q) - rank(p)).map(e => {
        const cy = y(e.at), lo = cy - SLOT / 2, hi = cy + SLOT / 2;
        const lane = used.findIndex(L => L.every(([a, b]) => hi <= a || lo >= b));
        if (lane !== -1) used[lane].push([lo, hi]);
        return { ...e, cy, lane };
      });
      // far lanes first, so nearer labels sit on top of the stems that pass behind them
      placed.sort((p, q) => q.lane - p.lane).forEach(p => {
        const cls = (p.ev === "ddl" ? (p.c.status !== "confirmed" ? " est" : "") : ` ev-${p.ev}`) + role(p.c) + (p.at <= now ? " past" : "")
          + (p.c === upcoming && p.ev === "ddl" && !lit ? " next" : "") + (gradeOf(p.c) === "A" ? " g-a" : "");
        const tip = esc(tipOf(p.c));
        if (p.lane === -1) {
          v += `<button type="button" class="tlv-bare${cls}" data-id="${esc(p.c.id)}" style="top:${p.cy}px;left:${AX}px" title="${tip}" aria-label="${tip}"></button>`;
          return;
        }
        const label = p.text || `${p.c.title} ${String(p.c.year).slice(2)}`;
        v += `<button type="button" class="tlv-pin${cls}" data-id="${esc(p.c.id)}" style="top:${p.cy}px;left:${AX}px;--tlx:${14 + p.lane * laneW}px;--tlw:${laneW - 6}px" title="${tip}">
          <span class="stem"></span><span class="dot"></span><span class="lbl">${esc(label)}</span></button>`;
      });
      tl.innerHTML = v + `</div>`;
      tl.classList.add("is-vert");
      tl.classList.remove("is-list");
    } else if (!opts.el) {
      tl.innerHTML = quietAxis();
      tl.classList.remove("is-vert", "is-list");
    } else {
      tl.innerHTML = html + `</div>`;
      tl.classList.remove("is-vert", "is-list");
    }
    tl.classList.toggle("has-path", !!path);
    tl.classList.toggle("has-glow", !!glow);
    if (!opts.el) {
      const src = glow && glow.src;
      // following the big countdown by default: say so and invite a tap; after a tap, offer the way back
      $("#tlLegend").innerHTML = src
        ? `<span class="lg-follow">Next for <b>${esc(src.title)} ${String(src.year).slice(-2)}</b></span> <span><i class="lg lg-reb"></i>during its rebuttal</span> <span><i class="lg lg-dec"></i>after its decision</span> ` +
          `<button type="button" class="lg-clear">✕ clear</button>`
        : `<span><i class="lg lg-dot"></i>deadline</span> <span><i class="lg lg-hollow"></i>estimated</span> <span><i class="lg lg-next"></i>next up</span> <span class="lg-hint">tap one for its reviews and where it could go next</span>`;
    }
    if (opts.path) renderPath(path, now);

    if (path && hasGsap && !reduced) {
      gsap.fromTo($$(".arc", tl), { opacity: 0 }, { opacity: (i, el) => (el.classList.contains("arc-top") ? 0.95 : 0.55), duration: 0.6, ease: "power2.out", stagger: 0.06 });
      gsap.fromTo($$(".tl-band", tl), { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out", transformOrigin: "left" });
    } else if (glow && hasGsap && !reduced && $(".tl-axis", tl)) {
      gsap.fromTo($$(".tl-src .dot, .tl-reb .dot, .tl-dec .dot", tl), { scale: 0.3 }, { scale: 1, duration: 0.5, ease: "back.out(3)", stagger: 0.03 });
    } else if (hasGsap && fx && !opts.quiet && $(".tlx-axis", tl)) {
      gsap.fromTo($(".tlx-axis", tl), { scaleX: 0 }, { scaleX: 1, duration: 1, ease: "expo.inOut" });
      gsap.from($$(".tlx-pin", tl), { opacity: 0, clearProps: "opacity", duration: 0.5, ease: "power2.out", stagger: { amount: 0.6 }, delay: 0.3 });
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

  /* ---------- calendar feeds: .ics files built on deploy by scripts/build_calendar.py ---------- */

  const feedSlug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const feedUrl = path => new URL(`calendar/${path}`, location.href.split("#")[0]).href;
  // The Worker (worker/) that serves "My conferences" as one live feed, when index.html names one. This browser
  // gets a random id the first time the dialog opens; the Worker keeps the id's starred series, and the page
  // sends them again whenever a star changes, so the subscribed URL stays the same and follows the stars.
  const calWorker = () => {
    const base = ($('meta[name="confddl-calendar-worker"]') || {}).content;
    return base ? base.replace(/\/?$/, "/") : "";
  };
  function calId(create) {
    let id = store.get("calId", "");
    if (!id && create) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      store.set("calId", id);
    }
    return id;
  }
  const mineFeed = () => (calWorker() && calId(true) ? `${calWorker()}u/${calId()}.ics` : "");
  let starSyncTimer = 0;
  function syncStars(now = false) {
    const base = calWorker(), id = calId(false);
    if (!base || !id) return; // nothing to keep in step until this browser has a calendar link
    clearTimeout(starSyncTimer);
    starSyncTimer = setTimeout(() => {
      const body = JSON.stringify({ series: [...state.starred].map(feedSlug).sort() });
      if (body === store.get("calSynced", "")) return;
      fetch(`${base}u/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: true })
        .then(r => { if (r.ok) store.set("calSynced", body); }).catch(() => {});
    }, now ? 0 : 800);
  }

  // Devices that share an id share their stars: read what another device saved and take it in.
  // Changed only elsewhere → take theirs; changed on both sides → keep the union; then save the result.
  async function pullStars() {
    const base = calWorker(), id = calId(false);
    if (!base || !id) return;
    let remote;
    try {
      const r = await fetch(`${base}u/${id}`, { cache: "no-store" });
      if (!r.ok) return;
      remote = ((await r.json()).series || []).slice().sort();
    } catch { return; }
    const last = (() => { try { return JSON.parse(store.get("calSynced", "")).series; } catch { return []; } })();
    const local = [...state.starred].map(feedSlug).sort();
    const same = (a, b) => a.join() === b.join();
    if (same(remote, last) || same(remote, local)) {
      if (same(remote, local)) store.set("calSynced", JSON.stringify({ series: remote }));
      return syncStars(true);
    }
    const next = same(local, last) ? remote : [...new Set([...local, ...remote])];
    const bySlug = new Map(confs.map(c => [feedSlug(seriesOf(c)), seriesOf(c)]));
    state.starred = new Set(next.map(s => bySlug.get(s)).filter(Boolean));
    store.set("starred", [...state.starred]);
    store.set("calSynced", JSON.stringify({ series: remote }));
    showStars();
    syncStars(true);
  }
  function showStars() {
    for (const c of confs) if (c.el) $(".star", c.el).setAttribute("aria-pressed", isStarred(c));
    $("#mineCount").textContent = state.starred.size || "";
    if (state.onlyStarred) apply();
    else { const now = Date.now(); refreshPicks(now); renderRail(now); }
  }

  /* ---------- sync stars between devices: a #sync=<id> link (or its QR code) puts another device on the same id ---------- */

  const syncLink = () => `${location.origin}${location.pathname}#sync=${calId(true)}`;
  let qrLib = null;
  const loadQr = () => qrLib || (qrLib = new Promise((ok, fail) => {
    const s = Object.assign(document.createElement("script"), { src: "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js", onload: ok, onerror: fail });
    document.head.append(s);
  }));
  async function openSync() {
    if (!calWorker()) return;
    const link = syncLink(); // makes this device's id first, so pullStars() can save its stars
    await pullStars();
    $("#syncLink").value = link;
    $("#syncQr").innerHTML = "";
    const box = $("#sync"), wasHidden = box.hidden;
    box.hidden = false;
    document.documentElement.classList.add("planner-open");
    if (wasHidden && hasGsap && !reduced) gsap.fromTo(".sync-sheet", { opacity: 0, y: 16 }, { opacity: 1, y: 0, clearProps: "transform", duration: dur(0.35), ease: "power3.out" });
    try {
      await loadQr();
      const qr = window.qrcode(0, "M");
      qr.addData(link);
      qr.make();
      $("#syncQr").innerHTML = qr.createSvgTag(4, 0);
    } catch { $("#syncQr").textContent = "QR code unavailable: copy the link instead."; }
  }
  function closeSync() {
    if ($("#sync").hidden) return;
    $("#sync").hidden = true;
    if ($("#planner").hidden && $("#feeds").hidden) document.documentElement.classList.remove("planner-open");
  }
  // opened from a sync link: join that id (stars on both devices are merged)
  function joinSync() {
    const m = location.hash.match(/^#sync=([A-Za-z0-9_-]{16,64})$/);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (!calWorker() || m[1] === calId(false)) return;
    if (!window.confirm("Sync your ★ conferences with the other device? Stars on this device are kept and merged in.")) return;
    store.set("calId", m[1]);
    store.set("calSynced", "");
    pullStars();
  }
  function feedRow(label, path, sub = "", url = "") {
    const https = url || feedUrl(path);
    const webcal = https.replace(/^https?:/, "webcal:");
    return `<li class="feed"><span class="feed-name"><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span>
      <span class="feed-acts">
        <a class="link" href="https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}" target="_blank" rel="noopener">Google</a>
        <a class="link" href="${esc(webcal)}">Apple / Outlook</a>
        <button type="button" class="link feed-copy" data-url="${esc(https)}">Copy link</button>
      </span></li>`;
  }
  function openFeeds() {
    const starred = [...state.starred].sort();
    if (calWorker()) { calId(true); pullStars(); }
    const count = pred => confs.filter(pred).length;
    $("#feedsBody").innerHTML =
      `<h3 class="feeds-h">Everything</h3><ul class="feeds-list">${feedRow("All conferences", "all.ics", `${confs.length} entries · deadlines, rebuttals and decisions`)}</ul>` +
      `<h3 class="feeds-h">My conferences</h3>` +
      (calWorker()
        ? `<ul class="feeds-list">${feedRow("All my conferences in one", "", starred.length ? starred.join(", ") : "nothing starred yet", mineFeed())}</ul>
          <p class="feeds-empty">One subscription that follows your stars: star or unstar a conference here and the calendar changes with it
            on its next refresh, no need to subscribe again. Subscribe once in Google or iCloud and it shows on your phone and computer;
            to keep the same stars on the site too, use “⇄ Sync with another device” under My conferences.</p>`
        : starred.length
        ? `<ul class="feeds-list"><li class="feed"><span class="feed-name"><b>All my conferences in one</b><small>${esc(starred.join(", "))}</small></span>
            <span class="feed-acts"><button type="button" class="link feed-mine">Download .ics</button></span></li></ul>
          <p class="feeds-empty">One file with every starred series. It is a snapshot: import it again after you star more, or to pick up
            changed dates (the events keep their IDs, so they update instead of doubling). To have changes arrive by themselves, subscribe series by series:</p>
          <details class="feeds-each"><summary>Subscribe series by series (${starred.length})</summary>
            <ul class="feeds-list">${starred.map(s => feedRow(s, `series/${feedSlug(s)}.ics`, "every edition, including future years")).join("")}</ul></details>`
        : `<p class="feeds-empty">Star a conference (☆ next to its name) to get a calendar for just your conferences here.</p>`) +
      `<h3 class="feeds-h">By field</h3><ul class="feeds-list">${Object.entries(data.areas || {})
        .filter(([a]) => count(c => c.area.includes(a)))
        .map(([a, label]) => feedRow(label, `area/${feedSlug(a)}.ics`, `${count(c => c.area.includes(a))} entries`)).join("")}</ul>`;
    const box = $("#feeds"), wasHidden = box.hidden;
    box.hidden = false;
    document.documentElement.classList.add("planner-open");
    if (wasHidden && hasGsap && !reduced) gsap.fromTo(".feeds-sheet", { opacity: 0, y: 16 }, { opacity: 1, y: 0, clearProps: "transform", duration: dur(0.35), ease: "power3.out" });
  }
  // one .ics for every starred series: the per-series feeds merged into a single calendar
  async function downloadMine(btn) {
    const starred = [...state.starred].sort();
    const label = btn.textContent;
    btn.textContent = "Preparing…";
    try {
      const texts = await Promise.all(starred.map(s => fetch(feedUrl(`series/${feedSlug(s)}.ics`)).then(r => (r.ok ? r.text() : ""))));
      const parts = texts.filter(t => t.includes("BEGIN:VEVENT"));
      if (!parts.length) throw new Error("no calendar files");
      const head = parts[0].slice(0, parts[0].indexOf("BEGIN:VEVENT"))
        .replace(/X-WR-CALNAME:[^\r\n]*(\r\n [^\r\n]*)*/, "X-WR-CALNAME:My conferences · Conf DDL")
        .replace(/X-WR-CALDESC:[^\r\n]*(\r\n [^\r\n]*)*/, `X-WR-CALDESC:${starred.join("\\, ")} from Conf DDL`);
      const events = parts.map(t => t.slice(t.indexOf("BEGIN:VEVENT"), t.lastIndexOf("END:VCALENDAR"))).join("");
      saveIcs("my-conferences.ics", head + events + "END:VCALENDAR\r\n");
      btn.textContent = "Downloaded ✓";
    } catch (err) {
      console.error(err);
      btn.textContent = "Couldn't build it, try again";
    }
    setTimeout(() => { btn.textContent = label; }, 2200);
  }
  function closeFeeds() {
    if ($("#feeds").hidden) return;
    $("#feeds").hidden = true;
    if ($("#planner").hidden) document.documentElement.classList.remove("planner-open");
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
    $("#railCount").textContent = state.starred.size || "";
    if (!picked.length) {
      $("#rail").innerHTML = `<p class="rail-empty">Follow a conference to see all its dates here, every year. Tap <b>☆</b> on any row, or start with one of these:</p><div class="quick-stars">${quickStars()}</div>`;
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
      order.map(a => `<button type="button" class="chip${state.areas.has(a) ? " is-on" : ""}" data-area="${esc(a)}" title="${esc(data.areas[a])}"><i class="ck" aria-hidden="true">✓</i>${esc(a)}<b>${counts[a]}</b></button>`).join("");
  }

  function apply({ animate = true } = {}) {
    const now = Date.now();
    $("#clearFilters").hidden = !(state.areas.size || state.onlyConfirmed || state.ranks.size);
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
    $("#pnCount").textContent = n.up;
    $("#countReview").textContent = n.review;
    $("#countPast").textContent = n.done;
    // "★ Mine" with nothing starred: offer quick stars instead of three empty tabs
    const noMine = state.onlyStarred && !state.starred.size;
    $("#mineEmpty").hidden = !noMine;
    if (noMine) $("#mineEmpty [data-quick]").innerHTML = quickStars();
    $("#mineCount").textContent = state.starred.size || "";
    $("#emptyUp").hidden = n.up > 0 || noMine;
    $("#emptyReview").hidden = n.review > 0 || noMine;
    $("#emptyPast").hidden = n.done > 0 || noMine;
    // a search that finds nothing in this tab moves to the first tab that has matches (not remembered)
    if (state.q && !n[state.tab]) {
      const hit = ["up", "review", "done"].find(t => n[t]);
      if (hit) showTab(hit, false);
    }

    refreshPicks(now);
    renderTimeline(visible, now); // it keeps the last three months and the next nine
    renderRail(now);

    if (flipState) {
      Flip.from(flipState, {
        duration: dur(0.45), ease: "power3.inOut", stagger: lite ? 0 : 0.012,
        onEnter: els => gsap.fromTo(els, { opacity: 0, y: 10 }, { opacity: 1, y: 0, clearProps: "transform", duration: 0.4, ease: "power2.out" }),
        onComplete: () => {
          gsap.set(cards, { clearProps: "transform,opacity" });
        },
      });
    }
  }

  function persist() {
    store.set("areas", [...state.areas]);
    store.set("onlyConfirmed", state.onlyConfirmed);
    RANKS.forEach(k => store.set(k, state.ranks.has(k)));
    store.set("onlyStarred", state.onlyStarred);
    store.set("starred", [...state.starred]);
    syncStars();
  }

  // Upcoming / In review / Decided tabs
  function showTab(tab, save = true) {
    state.tab = tab;
    if (save) store.set("listTab", tab);
    $$(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
    $$(".tab-panel").forEach(p => { p.hidden = p.id !== "panel-" + tab; });
  }
  function showScope(mine) {
    state.onlyStarred = mine;
    $$("#scope button").forEach(b => b.classList.toggle("is-on", (b.dataset.scope === "mine") === mine));
  }

  // star or unstar a whole series (every edition), from a row's ☆ or a quick-star button
  function setSeriesStar(key, on) {
    on ? state.starred.add(key) : state.starred.delete(key);
    confs.filter(c => seriesOf(c) === key).forEach(c => c.el && $(".star", c.el).setAttribute("aria-pressed", on));
    persist();
    showStars();
  }
  // the first series to suggest to someone with no stars: the best-known venues in the data
  const QUICK = ["CVPR", "ICCV", "ECCV", "NeurIPS", "ICML", "ICLR", "AAAI", "ACL", "EMNLP", "SIGGRAPH", "KDD", "CHI"];
  const quickStars = () => {
    const have = new Set(confs.map(seriesOf));
    return QUICK.filter(k => have.has(k)).map(k => `<button type="button" class="quick-star" data-series="${esc(k)}">☆ ${esc(k)}</button>`).join("");
  };

  // scroll a row into view and flash it
  function flashCard(c) {
    if (page !== 1) { goPage(1, () => flashCard(c)); return; } // the list page first
    if (c.group !== state.tab) showTab(c.group, false); // then its tab
    c.el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    c.el.classList.remove("flash");
    void c.el.offsetWidth;
    c.el.classList.add("flash");
  }

  /* ---------- share: a #c=<id> link opens the page with that conference in the big countdown ---------- */

  const shareUrl = c => `${location.origin}${location.pathname}#c=${encodeURIComponent(c.id)}`;
  async function shareConf(c, btn) {
    if (!c) return;
    const url = shareUrl(c);
    // phones get the system share sheet; elsewhere the link is copied
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title: `${c.title} ${c.year} countdown`, text: `${c.title} ${c.year} deadline: ${fmtTime(c.ddl)}`, url }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    if (!(await copyText(url))) { window.prompt("Copy this link", url); return; }
    btn.dataset.label ??= btn.innerHTML;
    btn.textContent = "Link copied ✓";
    clearTimeout(btn.copiedTimer);
    btn.copiedTimer = setTimeout(() => { btn.innerHTML = btn.dataset.label; }, 1800);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    // no Clipboard API (plain http, older browsers): copy from a hidden text field
    const ta = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  }
  function openShared() {
    const m = location.hash.match(/^#c=([\w-]+)/);
    const c = m && confs.find(x => x.id === m[1]);
    if (!c) return;
    showCountdown(c.id, "shared link");
  }
  // put a conference in the big countdown (and light up its next venues), on the countdown page
  function showCountdown(id, scope = null) {
    state.lightId = state.manualId = id;
    state.manualScope = scope;
    refreshPicks(Date.now());
    renderTimeline(timelineList, Date.now(), { quiet: true });
    const top = () => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    page === 0 ? top() : goPage(0, top, 0);
  }

  /* ---------- two pages: the countdown (hero + timeline) and the conference list ----------
     Swipe sideways on a phone, swipe on a trackpad, press ← / →, or tap the tabs at the bottom.
     The page out of view keeps its width (so it lays out and measures as usual) but no height,
     so the window scroll belongs to the page in view; each page remembers where it was. */
  let page = 0;
  const pagePos = [0, 0];
  let goPage = () => {};

  /* The countdown page is exactly one screen tall on every device, laid out for the shape of the screen:
       h    wide and tall enough: the hero, then the timeline as a horizontal strip
       cols landscape: the hero on the left, the timeline as a list of months on the right, full height
       v    portrait: the hero, then the list of months below it
     The list of months scrolls inside its own box. If the hero is too tall for its space it sheds detail
     step by step (f1…f4, see style.css) and then scales down; the timeline always stays. */
  const FIT = ["f1", "f2", "f3", "f4"], LAYOUTS = ["m-h", "m-cols", "m-v"];
  let fitQueued = false, fitting = false;
  let fitSize = ""; // the window size the countdown page was last fitted to
  function fitNow() {
    const pg = $("#pgNow"), hero = $("#hero"), wrap = $(".timeline-wrap"), nav = $("#pagerNav");
    if (!pg || !nav || fitting) return;
    fitting = true;
    fitSize = `${window.innerWidth}x${window.innerHeight}`;
    try {
      const top = $("#pagerTrack").getBoundingClientRect().top + window.scrollY;
      const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const navRoom = nav.offsetHeight + 2 * Math.max(8, window.innerHeight - nav.getBoundingClientRect().bottom);
      pg.style.setProperty("--now-h", Math.max(0, Math.floor(vh - top)) + "px");
      pg.style.setProperty("--nav-room", Math.ceil(navRoom) + "px");
      const room = vh - top - navRoom, W = pg.clientWidth;
      // how far the page's right edge is from the screen's, for the right sidebar to reach it
      const main = pg.closest("main"), mainRight = main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight);
      pg.style.setProperty("--edge", Math.max(0, Math.round(document.documentElement.clientWidth - mainRight)) + "px");
      const heroH = () => hero.getBoundingClientRect().height;
      const useList = v => {
        if (tlVertical === v) return;
        tlVertical = v;
        if (timelineList.length) renderTimeline(timelineList, Date.now(), { quiet: true });
      };
      // try one layout: shed up to maxLevel steps, then scale down to minZoom; true if it fits
      const tryMode = (mode, maxLevel, minZoom, tlNeed) => {
        pg.classList.remove(...LAYOUTS, ...FIT);
        pg.classList.add(mode);
        useList(mode !== "m-h");
        for (let i = 0; ; i++) {
          hero.style.zoom = "";
          const space = room - tlNeed();
          if (heroH() <= space) return true;
          if (i >= maxLevel) {
            // scaling widens the clock's container (its digits size to it), so settle in a few passes
            let z = space / heroH();
            if (z < minZoom) return false;
            for (let k = 0; k < 4; k++) {
              hero.style.zoom = z.toFixed(3);
              const h = heroH();
              if (h <= space && h > space - 4) break;
              z *= space / h;
            }
            if (heroH() > space) hero.style.zoom = (z * space / heroH() - 0.005).toFixed(3);
            return parseFloat(hero.style.zoom) >= minZoom;
          }
          pg.classList.add(FIT[i]);
        }
      };
      const head = () => $(".section-head", wrap).offsetHeight + 12;
      const strip = () => { const inner = $(".timeline-inner", wrap); return head() + (inner ? inner.offsetHeight + 8 : 100); }; // before the data: about the quiet axis
      const list = () => head() + Math.min(320, Math.max(190, room * 0.36)); // room for the standing axis
      if (!(W >= 700 && tryMode("m-h", 2, 0.9, state.tlView === "list" ? list : strip))) {
        if (W / Math.max(room, 1) >= 1.15) tryMode("m-cols", 4, 0.3, () => 0);
        // folded: the timeline waits behind its icon in the bottom bar, so the countdown keeps as much as it can,
        // a little smaller rather than without its venue
        // small screens shed the full name and tighten the chips before the clock shrinks at all
        else if (pg.classList.contains("tl-folded")) {
          // one measuring pass: the scale each shed level would need; the least shed one that keeps the clock at 95%
          // (else 84%) wins, and only that one is fitted
          pg.classList.remove(...LAYOUTS, ...FIT);
          pg.classList.add("m-v");
          useList(true);
          hero.style.zoom = "";
          const need = [];
          for (let i = 0; i < 4; i++) {
            if (i) pg.classList.add(FIT[i - 1]);
            need.push(room / heroH());
            if (need[i] >= 1) break;
          }
          const pick = [0.95, 0.84].map(z => need.findIndex(n => n >= z)).find(i => i >= 0);
          if (pick === undefined || !tryMode("m-v", pick, 0.84, () => 0)) tryMode("m-v", 4, 0.3, () => 0);
        }
        // phones: the month list scrolls inside whatever room it gets, so the countdown keeps its size and the list gives
        else if (W < 560 && state.tlView === "list" && tryMode("m-v", 4, 0.88, () => head() + Math.max(120, room * 0.24)));
        else tryMode("m-v", 4, 0.3, list);
      }
      // the standing axis is laid out in pixels for its box; draw it again now that the hero has settled
      if ((tlVertical || state.tlView === "list" || tlStale) && timelineList.length) renderTimeline(timelineList, Date.now(), { quiet: true });
      // the city photo: behind the whole screen when the timeline sits beside the hero or is folded away;
      // otherwise it ends just inside the timeline, which then sits on solid ground
      const bg = $(".page-bg");
      if (pg.classList.contains("m-cols") || !wrap.offsetHeight) bg.style.height = Math.ceil(window.innerHeight) + "px";
      else bg.style.height = Math.round(wrap.getBoundingClientRect().top - pg.getBoundingClientRect().top + top + 70) + "px";
    } finally { fitting = false; }
  }
  const scheduleFit = () => {
    if (fitQueued || fitting) return; // fitNow re-renders the timeline itself; don't loop
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fitNow(); });
  };
  function initPager() {
    const pager = $("#pager"), track = $("#pagerTrack"), pgs = [$("#pgNow"), $("#pgList")];
    const nav = $("#pagerNav"), navBtns = $$("[data-go]", nav);
    const W = () => pager.clientWidth;
    const setGlide = p => nav.style.setProperty("--p", p);
    const mark = i => {
      pgs.forEach((el, k) => { el.classList.toggle("is-cur", k === i); el.inert = k !== i; });
      navBtns.forEach((b, k) => b.setAttribute("aria-selected", k === i));
      document.body.dataset.page = i ? "list" : "now";
      document.documentElement.classList.toggle("on-now", !i); // the countdown page never scrolls
      setGlide(i);
    };
    // show both pages, the incoming one shifted so it appears where it will sit after the switch
    // the search and filters stay where they are while the pages slide under them; they only fade with the list.
    // They run the opposite transition to the track's, so the two cancel out on the compositor
    const ctl = $(".controls");
    const slideCtl = (x, how) => {
      const w = track.offsetWidth;
      ctl.style.transition = how ? `transform ${how}, opacity ${how}` : "none";
      ctl.style.transform = `translateX(${-(x + w)}px)`;
      ctl.style.opacity = Math.min(1, Math.max(0, -x / w));
    };
    const beginMove = to => {
      track.style.transform = `translateX(${-page * 100}%)`; // hold the resting place the stylesheet gives it, or the slide back has nowhere to start from
      slideCtl(-page * track.offsetWidth);
      pager.classList.add("is-moving");
      pgs[to].style.transform = `translateY(${window.scrollY - pagePos[to]}px)`;
    };
    const endMove = () => {
      ctl.style.transition = ctl.style.transform = ctl.style.opacity = "";
      pager.classList.remove("is-moving");
      pgs.forEach(el => { el.style.transform = ""; });
      track.style.transition = track.style.transform = "";
    };
    let done = null;
    const finish = (to, after) => {
      endMove();
      page = to;
      mark(to);
      // the countdown keeps its fit while away (its own changes re-fit it); only a new window size needs another
      if (to === 0) { pagePos[0] = 0; if (fitSize !== `${window.innerWidth}x${window.innerHeight}`) fitNow(); }
      store.set("page", to);
      window.scrollTo({ top: pagePos[to], behavior: "instant" });
      if (after) requestAnimationFrame(after);
    };
    goPage = (to, after, pos) => {
      if (to === page) { after && after(); return; }
      pagePos[page] = window.scrollY;
      if (pos != null) pagePos[to] = pos;
      if (reduced) { finish(to, after); return; }
      beginMove(to);
      document.body.dataset.page = to ? "list" : "now"; // the backdrops cross-fade during the slide, not after it
      track.style.transition = "transform .38s cubic-bezier(.2, .8, .2, 1)";
      track.style.transform = `translateX(${-to * 100}%)`;
      slideCtl(-to * track.offsetWidth, ".38s cubic-bezier(.2, .8, .2, 1)");
      nav.style.setProperty("--p", to);
      clearTimeout(done);
      const end = e => { if (e && e.target !== track) return; clearTimeout(done); track.removeEventListener("transitionend", end); finish(to, after); };
      track.addEventListener("transitionend", end);
      done = setTimeout(end, 500); // in case transitionend never comes
    };

    page = location.hash.startsWith("#c=") ? 0 : store.get("page", 0) === 1 ? 1 : 0;
    mark(page);
    fitNow();
    window.addEventListener("resize", scheduleFit);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", scheduleFit);
    if (window.ResizeObserver) new ResizeObserver(scheduleFit).observe($("#hero"));
    if (document.fonts) document.fonts.ready.then(scheduleFit);
    // the left sidebar opening or closing slides the page; the right sidebar re-measures where the screen edge is
    $(".layout")?.addEventListener("transitionend", e => { if (e.target.classList.contains("layout")) scheduleFit(); });
    track.style.transform = "";
    pager.classList.toggle("on-list", page === 1); // first paint without a slide
    requestAnimationFrame(() => pager.classList.remove("on-list"));

    document.addEventListener("click", e => {
      const b = e.target.closest("[data-go]");
      if (!b) return;
      const to = +b.dataset.go;
      // tapping the tab you're on goes back to the top of that page (and the timeline back to today)
      if (to === page) {
        window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
        if (to === 0) tlToday($("#timeline"));
      } else goPage(to);
    });
    document.addEventListener("keydown", e => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
      if ($(".planner:not([hidden])")) return;
      if (e.key === "ArrowRight" && page === 0) goPage(1);
      if (e.key === "ArrowLeft" && page === 1) goPage(0);
    });

    // touch: follow the finger once the gesture is clearly sideways
    const sideScroller = el => {
      for (; el && el !== pager; el = el.parentElement) {
        const ox = getComputedStyle(el).overflowX;
        if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) return el;
      }
      return null;
    };
    let g = null;
    pager.addEventListener("touchstart", e => {
      if (e.touches.length !== 1) { g = null; return; }
      const t = e.touches[0], sc = sideScroller(e.target);
      g = { x: t.clientX, y: t.clientY, t: performance.now(), dx: 0, lock: null,
        // a row that scrolls sideways (area chips…) keeps the swipe unless it is already at that end
        atStart: !sc || sc.scrollLeft <= 0, atEnd: !sc || sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 1 };
    }, { passive: true });
    pager.addEventListener("touchmove", e => {
      if (!g) return;
      const t = e.touches[0], dx = t.clientX - g.x, dy = t.clientY - g.y;
      if (!g.lock) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        const side = Math.abs(dx) > Math.abs(dy) * 1.3 && (dx < 0 ? g.atEnd : g.atStart);
        if (!side) { g = null; return; }
        g.lock = true;
        g.to = 1 - page;
        pagePos[page] = window.scrollY;
        clearTimeout(done);
        track.style.transition = "none";
        beginMove(g.to);
      }
      e.preventDefault();
      // past the first or last page the track only gives a little
      const toward = (dx < 0 && page === 0) || (dx > 0 && page === 1);
      g.dx = toward ? dx : dx * 0.25;
      track.style.transform = `translateX(calc(${-page * 100}% + ${g.dx}px))`;
      slideCtl(-page * track.offsetWidth + g.dx);
      setGlide(Math.min(1, Math.max(0, page - g.dx / W())));
    }, { passive: false });
    const release = () => {
      if (!g || !g.lock) { g = null; return; }
      const v = g.dx / (performance.now() - g.t);
      const toward = (g.dx < 0 && page === 0) || (g.dx > 0 && page === 1);
      const go = toward && (Math.abs(g.dx) > W() * 0.25 || Math.abs(v) > 0.45);
      g = null;
      if (go) {
        const to = 1 - page;
        track.style.transition = "transform .3s cubic-bezier(.2, .8, .2, 1)";
        track.style.transform = `translateX(${-to * 100}%)`;
        slideCtl(-to * track.offsetWidth, ".3s cubic-bezier(.2, .8, .2, 1)");
        setGlide(to);
        const end = e => { if (e && e.target !== track) return; clearTimeout(done); track.removeEventListener("transitionend", end); finish(to); };
        track.addEventListener("transitionend", end);
        done = setTimeout(end, 450);
      } else {
        track.style.transition = "transform .25s ease";
        track.style.transform = `translateX(${-page * 100}%)`;
        slideCtl(-page * track.offsetWidth, ".25s ease");
        setGlide(page);
        const end = e => { if (e && e.target !== track) return; clearTimeout(done); track.removeEventListener("transitionend", end); endMove(); };
        track.addEventListener("transitionend", end);
        done = setTimeout(end, 350);
      }
    };
    pager.addEventListener("touchend", release);
    pager.addEventListener("touchcancel", release);

    // trackpad: a clear sideways swipe flips the page once
    let acc = 0, cool = 0, accTimer;
    pager.addEventListener("wheel", e => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
      const sc = sideScroller(e.target);
      if (sc && !(e.deltaX > 0 ? sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 1 : sc.scrollLeft <= 0)) return;
      e.preventDefault();
      if (performance.now() < cool) return;
      acc += e.deltaX;
      clearTimeout(accTimer);
      accTimer = setTimeout(() => { acc = 0; }, 200);
      if (Math.abs(acc) > 80) {
        const to = acc > 0 ? 1 : 0;
        acc = 0;
        if (to !== page) { cool = performance.now() + 700; goPage(to); }
      }
    }, { passive: false });
  }
  const clearShared = () => {
    state.manualScope = null;
    if (location.hash.startsWith("#c=")) history.replaceState(null, "", location.pathname + location.search);
  };

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
      if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); goPage(1, () => $("#q").focus()); }
      if (e.key === "Escape" && document.activeElement === $("#q")) { $("#q").value = ""; state.q = ""; apply(); $("#q").blur(); }
    });

    const oc = $("#onlyConfirmed");
    oc.checked = state.onlyConfirmed;
    showScope(state.onlyStarred);
    const narrowScope = matchMedia("(max-width: 640px)");
    $("#scope").addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      // on phones only "★ Mine" shows, as an on/off toggle; tapping it again goes back to All
      showScope(b.dataset.scope === "mine" && !(state.onlyStarred && b.dataset.scope === "mine" && narrowScope.matches));
      persist();
      apply();
    });
    showTab(["up", "review", "done"].includes(state.tab) ? state.tab : "up", false);
    $(".tabs").addEventListener("click", e => {
      const b = e.target.closest(".tab");
      if (!b) return;
      showTab(b.dataset.tab);
      // switched from deep in a long list: start the new tab from its top
      const list = $(".list"), bar = $(".list-bar");
      if (list.getBoundingClientRect().top < bar.getBoundingClientRect().top - 1)
        window.scrollTo({ top: list.getBoundingClientRect().top + scrollY - parseFloat(getComputedStyle(bar).top) });
    });
    // the tab bar sticks just under the filter bar, whose height changes with the screen and wrapping
    const ctl = $(".controls");
    const ctlH = () => document.documentElement.style.setProperty("--ctl-h", ctl.offsetHeight + "px");
    if (window.ResizeObserver) new ResizeObserver(ctlH).observe(ctl);
    ctlH();

    document.addEventListener("click", e => {
      const btn = e.target.closest(".star");
      if (!btn) return;
      const conf = confs.find(c => c.id === btn.closest(".card").dataset.id);
      const key = seriesOf(conf);
      const on = !state.starred.has(key);
      if (on && hasGsap && !reduced) gsap.fromTo(btn, { scale: 0.6, rotate: -30 }, { scale: 1, rotate: 0, duration: 0.5, ease: "back.out(3)" });
      setSeriesStar(key, on);
    });
    document.addEventListener("click", e => {
      const q = e.target.closest(".quick-star");
      if (q) setSeriesStar(q.dataset.series, !state.starred.has(q.dataset.series));
    });
    oc.addEventListener("change", () => { state.onlyConfirmed = oc.checked; persist(); apply(); });
    for (const k of RANKS) {
      const box = $("#" + k);
      box.checked = state.ranks.has(k);
      box.addEventListener("change", () => { box.checked ? state.ranks.add(k) : state.ranks.delete(k); persist(); apply(); });
    }
    $("#clearFilters").addEventListener("click", () => {
      state.areas.clear(); state.ranks.clear(); state.onlyConfirmed = oc.checked = false;
      RANKS.forEach(k => { $("#" + k).checked = false; });
      $$(".chip").forEach(el => el.classList.toggle("is-on", !el.dataset.area));
      persist(); apply();
    });

    $$(".seg button").forEach(b => {
      b.classList.toggle("is-on", b.dataset.tz === state.tz);
      b.addEventListener("click", () => {
        state.tz = b.dataset.tz;
        store.set("tz", state.tz);
        $$(".seg button").forEach(x => x.classList.toggle("is-on", x === b));
        paintTimes();
      });
    });

    // Theme: auto (the default) follows the local clock, light from 6:00 to 18:00; the button cycles auto → light → dark.
    // index.html sets the first one before paint with the same rule.
    const root = document.documentElement, themeBtn = $("#themeBtn"), themeMeta = $('meta[name="theme-color"]');
    const THEME_NAMES = { auto: "auto (light 6:00–18:00 local time)", light: "light", dark: "dark" };
    let themeMode = store.get("themeMode", "auto");
    const applyTheme = () => {
      const h = new Date().getHours();
      const theme = themeMode === "auto" ? (h >= 6 && h < 18 ? "light" : "dark") : themeMode;
      if (root.dataset.theme !== theme) root.dataset.theme = theme;
      themeMeta.content = theme === "light" ? "#f5f4ef" : "#12151c";
      themeBtn.dataset.mode = themeMode;
      themeBtn.title = `Theme: ${THEME_NAMES[themeMode]} · click to switch`;
      themeBtn.setAttribute("aria-label", themeBtn.title);
    };
    applyTheme();
    setInterval(() => { if (themeMode === "auto") applyTheme(); }, 60000);
    themeBtn.addEventListener("click", () => {
      themeMode = { auto: "light", light: "dark", dark: "auto" }[themeMode] || "auto";
      store.set("themeMode", themeMode);
      applyTheme();
    });

    $("#heroIcs").addEventListener("click", () => heroConf && icsFor(heroConf));


    // Mouse light (off by default; a switch in the footer turns it on). Only surfaces that are on screen and within
    // LIGHT_RANGE of the cursor get --lx / --ly (cursor position in their own box), so each move repaints just those.
    const LIT = ".topbar, .rail, .controls, .card, .rail-item, .fold-toggle, .digit, .pick, .venue, " +
      ".to-top, .search, .chip, .btn, .planner-btn, .seg, .icon-btn, .rail-toggle, .photo-next, .tl-pin .lbl";
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
        if (!$("#planner").hidden || document.body.dataset.page === "list") return; // covered (planner, or the list's ground): don't animate what's behind it
        panX((e.clientX / innerWidth - 0.5) * -4.5);
        panY((e.clientY / innerHeight - 0.5) * -1.5);
      }, { passive: true });
    }

    // back-to-top button, only once the hero is out of view
    const toTop = $("#toTop");
    const syncTop = () => { const h = window.scrollY < 600; if (toTop.hidden !== h) toTop.hidden = h; };
    window.addEventListener("scroll", syncTop, { passive: true });
    syncTop();
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }));

    const layout = $(".layout"), rt = $("#railToggle");
    const setRail = (open, save) => {
      layout.classList.toggle("rail-off", !open);
      if (!narrowRail.matches) $("#pnMine").setAttribute("aria-expanded", open);
      if (save) store.set("railPref", open);
    };
    // One way in: ★ in the bottom bar. Wide screens open the sidebar beside the page, narrow ones as a drawer;
    // ✕ in the sidebar (or the backdrop) closes it.
    const narrowRail = matchMedia("(max-width: 1100px)");
    const setDrawer = open => {
      layout.classList.toggle("drawer-open", open);
      if (narrowRail.matches) $("#pnMine").setAttribute("aria-expanded", open);
    };
    // open on wide screens once something is starred, until the reader closes it (or opens it) themselves
    setRail(store.get("railPref", null) ?? state.starred.size > 0);
    const toggleRail = open => {
      if (narrowRail.matches) { setDrawer(open); return; }
      setRail(open, true);
      scheduleFit();
    };
    rt.addEventListener("click", () => toggleRail(false));
    $("#pnMine").addEventListener("click", () => toggleRail(narrowRail.matches ? !layout.classList.contains("drawer-open") : layout.classList.contains("rail-off")));
    $("#railBackdrop").addEventListener("click", () => setDrawer(false));
    $("#rail").addEventListener("click", e => { if (narrowRail.matches && e.target.closest(".rail-item")) setDrawer(false); });
    narrowRail.addEventListener("change", () => setDrawer(false));
    $("#heroPicks").addEventListener("click", e => {
      const btn = e.target.closest(".pick");
      if (!btn) return;
      state.manualId = null;
      clearShared();
      if (state.lightId) { state.lightId = null; renderTimeline(timelineList, Date.now(), { quiet: true }); }
      state.heroMode = btn.dataset.mode;
      store.set("heroMode", state.heroMode);
      refreshPicks(Date.now());
    });

    const jump = e => {
      const pin = e.target.closest(".tl-pin, .rail-item");
      const c = pin && confs.find(x => x.id === pin.dataset.id);
      if (c) flashCard(c);
    };
    $("#heroShare").addEventListener("click", e => heroConf && shareConf(heroConf, e.currentTarget));
    document.addEventListener("click", e => {
      const btn = e.target.closest(".c-share");
      if (btn) shareConf(confs.find(x => x.id === btn.closest(".card").dataset.id), btn);
    });
    window.addEventListener("hashchange", openShared);
    $("#rail").addEventListener("click", jump);
    $("#timeline").addEventListener("click", e => {
      const group = e.target.closest(".tlx-pin[data-ids]"), open = $(".tlx-pop", e.currentTarget);
      if (open && !e.target.closest(".tlx-pop")) open.remove();
      if (group) {
        if (open && open.dataset.at === group.style.left) return; // a second tap closes it
        const inner = group.parentElement, pop = document.createElement("div");
        pop.className = "tlx-pop";
        pop.dataset.at = group.style.left;
        pop.innerHTML = group.dataset.ids.split(" ").map(id => confs.find(c => c.id === id)).filter(Boolean).map(c =>
          `<button type="button" class="tl-chip${c.status !== "confirmed" ? " est" : ""}" data-id="${esc(c.id)}">${esc(c.title)} ${String(c.year).slice(2)}<small>${esc(fmtShort.format(c.ddl))}</small></button>`).join("");
        inner.append(pop);
        const w = inner.clientWidth, at = group.offsetLeft;
        pop.style.left = Math.max(0, Math.min(w - pop.offsetWidth, at - 12)) + "px";
        return;
      }
      const pin = e.target.closest(".tl-pin, .tl-dot, .tl-bare, .tlv-pin, .tlv-bare, .tlv-dot, .tl-chip, .tlx-pin");
      if (!pin) return;
      // click lights up the next venues (and shows it in the big countdown); clicking it again clears
      const again = state.lightId === pin.dataset.id;
      clearShared();
      state.lightId = again ? null : pin.dataset.id;
      state.manualId = again ? null : pin.dataset.id;
      refreshPicks(Date.now());
      renderTimeline(timelineList, Date.now(), { quiet: true });
      if (again) return;
      const top = $("#hero").getBoundingClientRect().top + window.scrollY - 70;
      if (window.scrollY > top) window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
    });
    document.addEventListener("click", e => {
      const b = e.target.closest(".c-focus");
      if (!b) return;
      clearShared();
      showCountdown(b.closest(".card").dataset.id);
    });

    // Axis / Months and 3M / 6M / 1Y above the timeline
    const tlCtl = () => {
      $$("#tlView button").forEach(b => b.classList.toggle("is-on", b.dataset.view === state.tlView));
    };
    tlCtl();
    // in two columns the timeline can fold into a thin strip, leaving the screen to the countdown
    const fold = on => {
      $("#pgNow").classList.toggle("tl-folded", on);
      $("#tlFold").setAttribute("aria-expanded", String(!on));
      $("#tlFold").title = on ? "Show the timeline" : "Fold the timeline away";
      $("#pnTl").setAttribute("aria-pressed", String(!on));
    };
    fold(store.get("tlFold", true)); // folded until the reader opens it (two columns and phones; wide screens always show it)
    $("#tlFold").addEventListener("click", () => {
      const on = !$("#pgNow").classList.contains("tl-folded");
      store.set("tlFold", on);
      fold(on);
      fitNow();
    });
    // stacked layouts (phones): the bottom bar's timeline icon opens and folds it, from either page
    $("#pnTl").addEventListener("click", () => {
      if (document.body.dataset.page === "list") { $('#pagerNav [data-go="0"]').click(); if ($("#pgNow").classList.contains("tl-folded")) $("#tlFold").click(); }
      else $("#tlFold").click();
    });
    $(".tl-ctl").addEventListener("click", e => {
      const b = e.target.closest("button[data-view]");
      if (!b) return;
      if (b.dataset.view) { state.tlView = b.dataset.view; store.set("tlView", state.tlView); }
      tlCtl();
      renderTimeline(timelineList, Date.now(), { quiet: true });
    });

    $("#tlLegend").addEventListener("click", e => {
      if (!e.target.closest(".lg-clear")) return;
      state.lightId = null; state.manualId = null;
      clearShared();
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
    document.addEventListener("keydown", e => { if (e.key === "Escape") { closePlanner(); closeFeeds(); closeSync(); } });
    $("#syncBtn").hidden = !calWorker();
    $("#syncBtn").addEventListener("click", openSync);
    $("#railCal").addEventListener("click", openFeeds);
    $("#sync").addEventListener("click", async e => {
      if (e.target.closest("[data-close]")) return closeSync();
      const copy = e.target.closest("#syncCopy");
      if (copy) {
        if (!(await copyText($("#syncLink").value))) { $("#syncLink").select(); return; }
        copy.textContent = "Copied ✓";
        setTimeout(() => { copy.textContent = "Copy link"; }, 1800);
      }
      if (e.target.closest("#syncStop") && window.confirm("Stop syncing this device? Its stars stay as they are, and its calendar link changes.")) {
        store.set("calId", "");
        store.set("calSynced", "");
        closeSync();
      }
    });
    $("#calBtn").addEventListener("click", openFeeds);
    $("#feeds").addEventListener("click", async e => {
      if (e.target.closest("[data-close]")) return closeFeeds();
      if (e.target.closest(".feed-mine")) return downloadMine(e.target.closest(".feed-mine"));
      const btn = e.target.closest(".feed-copy");
      if (!btn) return;
      if (!(await copyText(btn.dataset.url))) { window.prompt("Copy this link", btn.dataset.url); return; }
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = "Copy link"; }, 1800);
    });

    // rows fold open to show the details
    // the whole row opens it (not just the name), except the star and anything else clickable
    document.addEventListener("click", e => {
      const main = e.target.closest(".row-main");
      if (!main || e.target.closest(".star, a, button:not(.row-toggle)")) return;
      if (!e.target.closest(".row-toggle") && String(getSelection())) return; // selecting a date to copy it
      const btn = $(".row-toggle", main);
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

    // the search, filters and tabs stay see-through: instead of the rows passing under them, each part of the list
    // below the tabs is cut off at the tabs' lower edge
    let cutQueued = false;
    const cut = () => {
      cutQueued = false;
      if (document.body.dataset.page !== "list") return;
      // all reads, then all writes; and clip-path itself rather than a custom property, which every card under it
      // would inherit and so restyle on each scrolled frame
      const y = $(".list-bar").getBoundingClientRect().bottom;
      const els = [...$$("#pgList .list > :not(.list-bar)"), $(".foot")].filter(el => el.offsetParent);
      const tops = els.map(el => el.getBoundingClientRect().top);
      els.forEach((el, i) => { el.style.clipPath = `inset(${Math.max(0, Math.round(y - tops[i]))}px -100vmax -100vmax)`; });
    };
    const queueCut = () => { if (!cutQueued) { cutQueued = true; requestAnimationFrame(cut); } };
    addEventListener("scroll", queueCut, { passive: true });
    addEventListener("resize", queueCut, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(queueCut).observe($("#pgList .list")); // a tab, filter or the page switch changes what is shown
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
        // a bare start day opens at its midnight; a bare end day closes at 23:59; either may carry its official time
        reb: Array.isArray(c.rebuttal) ? [parseDeadline(c.rebuttal[0].length > 10 ? c.rebuttal[0] : c.rebuttal[0] + " 00:00", c.rebuttal_timezone || c.timezone),
          parseDeadline(c.rebuttal[1], c.rebuttal_timezone || c.timezone)] : null,
        rebExact: Array.isArray(c.rebuttal) && c.rebuttal[1].length > 10,
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
    if (!hasGsap || !fx || !("IntersectionObserver" in window)) { list.forEach(c => { c.revealed = true; growBar(c); }); return; }
    gsap.set(list.map(c => c.el), { opacity: 0, y: 14 });
    // rows rise in as they come within 8% of the bottom edge, each once
    const io = new IntersectionObserver(entries => {
      // skip rows a filter change already revealed, so this never fights a running Flip
      const fresh = entries.filter(en => en.isIntersecting).map(en => (io.unobserve(en.target), en.target.conf)).filter(c => c && !c.revealed);
      if (!fresh.length) return;
      fresh.forEach(c => { c.revealed = true; growBar(c); });
      gsap.to(fresh.map(c => c.el), { opacity: 1, y: 0, clearProps: "transform", duration: 0.6, ease: "expo.out", stagger: 0.035 });
    }, { rootMargin: "0px 0px -8% 0px" });
    list.forEach(c => io.observe(c.el));
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
    initPager();
    bind();
    tickNow(Date.now());
    try {
      const res = await fetch(`data/conferences.json?v=${BUILD}`);
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (err) {
      $("#heroFull").textContent = "Couldn't load data/conferences.json. Serve this folder over HTTP (e.g. python3 -m http.server).";
      console.error(err);
      document.documentElement.classList.remove("pre-fit");
      return;
    }
    if (data.updated) $("#updated").textContent = "updated " + data.updated;
    build();
    const planHash = location.hash.match(/^#plan=([\w-]+)/);
    if (planHash) openPlanner(planHash[1]);
    openShared();
    joinSync();
    pullStars();
    tick();
    // the countdown shows once it has its data and has been fitted, so nothing on it jumps (style.css: .pre-fit)
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("pre-fit")));
    // align ticks to the wall-clock second
    // (skipped while the tab is hidden; it catches up as soon as it is shown again)
    setTimeout(() => { tick(); setInterval(() => { if (!document.hidden) tick(); }, 1000); }, 1000 - (Date.now() % 1000));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(); pullStars(); } });
  }

  init();
})();
