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
    const link = $(".c-link", el);
    link.href = c.link;
    $(".c-ics", el).addEventListener("click", () => icsFor(c));
    c.el = el;
    c.refs = {
      days: $(".c-days", el), unit: $(".c-unit", el), hms: $(".c-hms", el), bar: $(".bar i", el),
      ddl: $(".c-ddl", el), abs: $(".c-abs dd", el),
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

  function tickCard(c, now) {
    const left = c.ddl - now;
    const r = c.refs;
    if (left <= 0) {
      const ago = Math.floor(-left / DAY);
      r.days.textContent = ago;
      r.unit.textContent = ago === 1 ? "day ago" : "days ago";
      r.hms.textContent = "closed";
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
    const flipState = animate && hasGsap && window.Flip && !reduced ? Flip.getState(cards) : null;

    let up = 0, past = 0;
    const visible = [];
    for (const c of confs) {
      const show = matches(c);
      c.el.style.display = show ? "" : "none";
      if (show) { visible.push(c); c.ddl > now ? up++ : past++; }
    }
    $("#countUp").textContent = up;
    $("#countPast").textContent = past;
    $("#emptyUp").hidden = up > 0;

    const upcomingVisible = visible.filter(c => c.ddl > now);
    setHero(upcomingVisible[0] || confs.find(c => c.ddl > now) || null);
    renderTimeline(upcomingVisible, now);

    if (flipState) {
      Flip.from(flipState, {
        duration: 0.55, ease: "power3.inOut", absolute: true, stagger: 0.015, prune: true,
        onEnter: els => gsap.fromTo(els, { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.45, ease: "power2.out" }),
        onLeave: els => gsap.to(els, { opacity: 0, scale: 0.94, duration: 0.3, ease: "power2.in" }),
      });
    }
  }

  function persist() {
    store.set("areas", [...state.areas]);
    store.set("onlyConfirmed", state.onlyConfirmed);
    store.set("ccfA", state.ccfA);
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

    const oc = $("#onlyConfirmed"), ca = $("#ccfA");
    oc.checked = state.onlyConfirmed; ca.checked = state.ccfA;
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
        gsap.fromTo($$(".card", grid).filter(el => el.style.display !== "none"), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: 0.03 });
      }
    });

    $("#heroIcs").addEventListener("click", () => heroConf && icsFor(heroConf));

    $("#timeline").addEventListener("click", e => {
      const pin = e.target.closest(".tl-pin");
      if (!pin) return;
      const c = confs.find(x => x.id === pin.dataset.id);
      if (!c) return;
      c.el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      c.el.classList.remove("flash");
      void c.el.offsetWidth;
      c.el.classList.add("flash");
    });

    // cursor-following glow on cards
    document.addEventListener("pointermove", e => {
      const card = e.target.closest?.(".card");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    }, { passive: true });

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
      .map(c => ({ ...c, area: c.area || [], ddl: parseDeadline(c.deadline, c.timezone), abs: parseDeadline(c.abstract_deadline, c.timezone) }))
      .filter(c => c.ddl != null);
    const up = confs.filter(c => c.ddl > now).sort((a, b) => a.ddl - b.ddl);
    const past = confs.filter(c => c.ddl <= now).sort((a, b) => b.ddl - a.ddl);
    confs = [...up, ...past];
    nextBoundary = up.length ? up[0].ddl : Infinity;

    const upEl = $("#upcoming"), pastEl = $("#passed");
    upEl.innerHTML = ""; pastEl.innerHTML = "";
    up.forEach(c => upEl.appendChild(buildCard(c)));
    past.forEach(c => { pastEl.appendChild(buildCard(c)); c.el.classList.add("is-past"); });

    renderChips();
    paintTimes();
    apply({ animate: false });
    confs.forEach(c => tickCard(c, now));
    revealCards(up);
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
    gsap.set(list.map(c => c.el), { opacity: 0, y: 28 });
    ScrollTrigger.batch(list.map(c => c.el), {
      start: "top 92%", once: true,
      onEnter: els => {
        gsap.to(els, { opacity: 1, y: 0, duration: 0.8, ease: "expo.out", stagger: 0.06, overwrite: true });
        els.forEach(el => growBar(list.find(c => c.el === el)));
      },
    });
  }

  function tick() {
    const now = Date.now();
    if (now >= nextBoundary) { heroConf = null; build(); }
    tickHero(now);
    for (const c of confs) if (c.ddl > now - DAY && c.el.style.display !== "none") tickCard(c, now);
  }

  async function init() {
    bind();
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
