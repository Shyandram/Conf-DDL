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
    onlyStarred: store.get("onlyStarred", false),
    starred: new Set(store.get("starred", [])),
    tz: store.get("tz", "local"),
    showPast: false,
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

  /* ---------- helpers ---------- */

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function urgency(ms) {
    const d = ms / DAY;
    return d < HOT_DAYS ? "hot" : d < WARN_DAYS ? "warn" : "";
  }

  function matches(c) {
    if (state.onlyConfirmed && c.status !== "confirmed") return false;
    if (state.ccfA && c.ccf !== "A") return false;
    if (state.onlyStarred && !state.starred.has(c.id)) return false;
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
    $(".star", el).setAttribute("aria-pressed", state.starred.has(c.id));
    el.classList.toggle("is-est", c.status !== "confirmed");
    $(".c-name", el).textContent = c.title;
    $(".c-year", el).textContent = c.year;
    $(".c-full", el).textContent = c.full_name;
    $(".c-tags", el).innerHTML =
      (c.ccf ? `<span class="tag tag-ccf">CCF-${esc(c.ccf)}</span>` : "") +
      c.area.map(a => `<span class="tag">${esc(a)}</span>`).join("") +
      (c.status !== "confirmed" ? `<span class="tag tag-est">estimated</span>` : "");
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
    if (heroConf) $("#heroWhen").textContent = fmtTime(heroConf.ddl);
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
      const old = box.firstElementChild;
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

  // The hero counts down to what the viewer chose: starred first, then the filtered list, then everything.
  function pickHero(upcomingVisible, now) {
    const starred = confs.filter(c => c.ddl > now && state.starred.has(c.id));
    const filtered = state.areas.size || state.onlyConfirmed || state.ccfA || state.q || state.onlyStarred;
    let c, scope = "";
    if (starred.length) { c = starred[0]; scope = "My conferences"; }
    else if (upcomingVisible.length) { c = upcomingVisible[0]; scope = filtered ? "your filters" : ""; }
    else c = confs.find(x => x.ddl > now) || null;
    $("#heroScope").textContent = scope;
    setHero(c);
  }

  function setHero(c) {
    if (c === heroConf) return;
    const first = heroConf === null;
    heroConf = c;
    const hero = $("#hero");
    if (!c) {
      $("#heroName").textContent = "All clear";
      $("#heroYear").textContent = "";
      $("#heroFull").textContent = "No upcoming deadlines match your filters.";
      $("#heroWhen").textContent = "";
      $("#heroPlace").textContent = "";
      hero.classList.add("is-empty");
      return;
    }
    hero.classList.remove("is-empty");
    const chars = splitChars($("#heroName"), c.title);
    $("#heroYear").textContent = c.year;
    $("#heroFull").textContent = c.full_name + (c.status !== "confirmed" ? " · estimated date" : "");
    $("#heroWhen").textContent = fmtTime(c.ddl);
    $("#heroPlace").textContent = [c.place, c.date].filter(Boolean).join(" · ");
    $("#heroLink").href = c.link;
    if (hasGsap && !reduced) {
      gsap.fromTo(chars, { yPercent: 110 }, { yPercent: 0, duration: first ? 1.1 : 0.7, ease: "expo.out", stagger: 0.04, delay: first ? 0.15 : 0 });
      gsap.fromTo(["#heroYear", "#heroFull", ".hero-foot"], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.06, delay: first ? 0.4 : 0.1 });
    }
  }

  function tickHero(now) {
    const clock = $("#clock");
    const left = heroConf ? heroConf.ddl - now : 0;
    const t = split(left);
    setDigits("d", t.d); setDigits("h", t.h); setDigits("m", t.m); setDigits("s", t.s);
    const u = heroConf ? urgency(left) : "";
    clock.classList.toggle("is-hot", u === "hot");
    clock.classList.toggle("is-warn", u === "warn");
    if (heroConf) document.title = `${t.d}d ${pad(t.h)}:${pad(t.m)} · ${heroConf.title} ${heroConf.year} — Conf Deadlines`;
  }

  /* ---------- timeline ---------- */

  function renderTimeline(list, now) {
    const tl = $("#timeline");
    const start = new Date(now); start.setDate(1); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setMonth(end.getMonth() + 13);
    const span = end - start;
    const x = ms => ((ms - start) / span) * 100;

    let html = `<div class="timeline-inner"><div class="tl-axis"></div>`;
    for (let i = 0; i <= 12; i++) {
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
    pins.forEach(({ c, px, label, row }) => {
      const top = 8 + row * ROW;
      html += `<button type="button" class="tl-pin${c.status !== "confirmed" ? " est" : ""}" data-id="${esc(c.id)}"
        style="left:${px}%;top:${top}px;height:${axis + 5.5 - top}px" title="${esc(c.title + " " + c.year + " · " + fmtShort.format(c.ddl))}">
        <span class="lbl">${esc(label)}</span><span class="stem"></span><span class="dot"></span></button>`;
    });
    tl.innerHTML = html + `</div>`;

    if (hasGsap && !reduced) {
      gsap.fromTo($(".tl-axis", tl), { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "expo.inOut" });
      gsap.fromTo($$(".tl-pin", tl), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: "back.out(2)", stagger: 0.05, delay: 0.4 });
    }
  }

  /* ---------- left rail ---------- */

  let railItems = [];

  function shortLeft(ms) {
    const t = split(ms);
    return t.d >= 1 ? `${t.d}d` : `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`;
  }

  // The rail lists only the conferences the viewer has starred, whatever the filters say.
  function renderRail(now) {
    const picked = confs.filter(c => state.starred.has(c.id));
    $("#railSel").textContent = picked.length ? `${picked.length} starred` : "";
    if (!picked.length) {
      $("#rail").innerHTML = `<p class="rail-empty">Click the <b>☆</b> next to a conference to pin it here.</p>`;
      railItems = [];
      return;
    }
    const up = picked.filter(c => c.group === "up");
    const review = picked.filter(c => c.group === "review");
    const done = picked.filter(c => c.group === "done");
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
    pickHero(upcomingVisible, now);
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
      const id = btn.closest(".card").dataset.id;
      const on = !state.starred.has(id);
      on ? state.starred.add(id) : state.starred.delete(id);
      btn.setAttribute("aria-pressed", on);
      if (on && hasGsap && !reduced) gsap.fromTo(btn, { scale: 0.6, rotate: -30 }, { scale: 1, rotate: 0, duration: 0.5, ease: "back.out(3)" });
      persist();
      if (state.onlyStarred) apply();
      else { const now = Date.now(); pickHero(confs.filter(c => c.ddl > now && c.el.style.display !== "none"), now); renderRail(now); }
    });
    oc.addEventListener("change", () => { state.onlyConfirmed = oc.checked; persist(); apply(); });
    ca.addEventListener("change", () => { state.ccfA = ca.checked; persist(); apply(); });

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

    $("#passedToggle").addEventListener("click", () => {
      state.showPast = !state.showPast;
      const grid = $("#passed");
      $("#passedToggle").setAttribute("aria-expanded", state.showPast);
      grid.hidden = !state.showPast;
      if (state.showPast && hasGsap && !reduced) {
        gsap.fromTo($$(".card", grid).filter(el => el.style.display !== "none"), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out", stagger: 0.025 });
      }
    });

    $("#heroIcs").addEventListener("click", () => heroConf && icsFor(heroConf));

    const jump = e => {
      const pin = e.target.closest(".tl-pin, .rail-item");
      if (!pin) return;
      const c = confs.find(x => x.id === pin.dataset.id);
      if (!c) return;
      c.el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      c.el.classList.remove("flash");
      void c.el.offsetWidth;
      c.el.classList.add("flash");
    };
    $("#timeline").addEventListener("click", jump);
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
    if (now >= nextBoundary) { heroConf = null; build(); }
    tickHero(now);
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
    tick();
    // align ticks to the wall-clock second
    setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000 - (Date.now() % 1000));
  }

  init();
})();
