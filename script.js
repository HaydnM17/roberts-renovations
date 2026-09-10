/* Roberts Renovations, spec mockup.
   Scroll-film engine (canvas dissolve through eight build stages) plus every page behaviour.
   No dependencies, no build step. Every feature is guarded, so markup can arrive later. */
(function () {
  "use strict";
  var doc = document, win = window, root = doc.documentElement, body = doc.body;
  var qs = new URLSearchParams(location.search);
  var STILL = qs.has("still");
  var JUMP = qs.get("jump");
  var JANK = qs.has("jank");
  /* ?p=0..1 forces the film to a position without scrolling. Headless capture cannot scroll,
     so this is the only way to photograph the middle of the film. */
  var FORCE_P = qs.has("p") ? Math.max(0, Math.min(1, parseFloat(qs.get("p")) || 0)) : null;
  if (JUMP !== null) history.scrollRestoration = "manual";

  /* ---------------------------------------------------------------- config */
  var FILM = {
    /* zoom: a base push beyond cover. anchorY: where the visible window sits, 0.5 is centred.
       The portrait stills are sky-heavy by design (the header needs room), so on a phone we
       push in a little and sit low, which trims dead sky and puts the house at a useful size. */
    d: { dir: "assets/film/d", poster: "assets/poster-d.jpg", zoom: 1.0, anchorY: 0.5,
         topLum: [247, 248, 248, 245, 240, 241, 241, 241] },
    m: { dir: "assets/film/m", poster: "assets/poster-m.jpg", zoom: 1.16, anchorY: 0.74,
         topLum: [241, 244, 244, 240, 246, 248, 250, 250] }
  };
  /* Measured brightness of the top strip of every still, so the fixed chrome over the film knows
     whether to run dark or light without reading the canvas. Reading it would taint the canvas on
     a file:// preview and costs a pixel copy on every frame; a lookup costs nothing and is exact. */
  var GROUND_LUM = 21;      /* the page ground, #151513 */
  var LUM_SWITCH = 140;     /* above this the chrome runs dark, below it runs light */
  var STAGES = 8;                 /* eight stills, eight build stages */
  var SEAM = "#151513";           /* the film dissolves into the page ground */
  var HOLD = 0.30;                /* fraction of a segment each stage holds before dissolving */
  var KEN = 0.055;                /* slow push on each stage, fraction of width */

  var rmq = matchMedia("(prefers-reduced-motion: reduce)");
  var portraitQ = matchMedia("(orientation: portrait)");
  var coarseQ = matchMedia("(pointer: coarse)");
  var finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  var narrowQ = matchMedia("(max-width: 767px)");
  function reduced() { return rmq.matches || STILL; }

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var smoothstep = function (p, a, b) { var t = clamp((p - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var on = function (el, ev, fn, o) { if (el) el.addEventListener(ev, fn, o); };

  root.style.setProperty("--seam", SEAM);

  /* ---------------------------------------------------------------- nodes */
  var header = $(".site-header");
  var film = $("#film");
  var filmScroll = film && $(".film-scroll", film);
  var stage = film && $(".film-stage", film);
  var poster = film && $(".film-poster", film);
  var canvas = film && $(".film-canvas", film);
  var ctx = canvas ? canvas.getContext("2d", { alpha: false }) : null;
  var fadeEl = film && $(".film-fade", film);
  var scrimEl = film && $(".film-scrim", film);
  var vignEl = film && $(".film-vignette", film);
  var loaderEl = film && $(".film-loader i", film);
  var readout = film && $(".film-readout", film);
  var readoutStage = readout && $(".stage", readout);
  var readoutBar = readout && $(".bar i", readout);
  var readoutName = readout && $(".stage-name", readout);
  var ticks = readout ? $$(".tick", readout) : [];
  var STAGE_NAMES = ["Empty lot", "Dug out", "Foundation", "Framed", "Roof and wrap",
                     "Drywall and floors", "Kitchen and bath", "Finished"];
  var lastStageIdx = -1;
  var progressBar = $(".progress");

  var beats = film ? $$(".beat[data-in]", film).map(function (el) {
    return { el: el, a: +el.dataset.in, peak: +el.dataset.peak, b: +el.dataset.out, op: -1 };
  }) : [];

  /* ---------------------------------------------------------------- state */
  var setKey = null, dir = null, posterSrc = null, zoom = 1, anchorY = 0.5;
  var imgs = [], ok = [], loadedCount = 0, failed = 0;
  var target = 0, current = 0, rafId = null, lastTick = 0, painted = -1;
  var filmOn = false, firstDrawn = false, readyFired = false;
  var lastLum = -1, lastFade = -1, lastStageTxt = "", lastBar = -1;
  var jankMax = 0, jankAt = 0;

  function pickSet() { return (portraitQ.matches && win.innerWidth < 900) ? "m" : "d"; }

  function progress() {
    if (FORCE_P !== null) return FORCE_P;
    if (!filmScroll) return 0;
    var r = filmScroll.getBoundingClientRect();
    var range = r.height - win.innerHeight;
    if (range <= 0) return 0;
    return clamp(-r.top / range, 0, 1);
  }

  /* ---------------------------------------------------------------- film: loading */
  function loadFilm() {
    imgs = []; ok = []; loadedCount = 0; failed = 0; firstDrawn = false; painted = -1;
    /* Load the stage the visitor is actually looking at first, then everything else. Eight stills
       at once competes with the fonts and the stylesheet for the first second of the page. */
    var lead = FORCE_P !== null ? clamp(Math.floor(current), 0, STAGES - 1) : 0;
    var restStarted = false;
    function startRest() {
      if (restStarted) return;
      restStarted = true;
      for (var j = 0; j < STAGES; j++) if (j !== lead) load(j);
    }
    function load(n) {
      var im = new Image();
      im.decoding = "async";
      im.onload = function () {
        ok[n] = true; loadedCount++;
        if (n === lead) startRest();
        if (loaderEl) loaderEl.style.transform = "scaleX(" + (loadedCount / STAGES) + ")";
        if (loadedCount >= STAGES && film) film.classList.add("loaded");
        var need = FORCE_P !== null ? Math.floor(current) : 0;
        if (!firstDrawn && (ok[need] || ok[need + 1])) {
          firstDrawn = true;
          if (film) { film.classList.add("live"); }
          sizeCanvas(); paint(current, true); markReady();
        } else if (filmOn) { paint(current, true); }
      };
      im.onerror = function () {
        failed++;
        if (n === lead) startRest();
        if (failed > 2 && !firstDrawn) goStatic();
      };
      im.src = dir + (n + 1) + ".jpg";
      imgs[n] = im;
    }
    load(lead);
    /* never let a stalled lead image hold the rest back */
    win.setTimeout(startRest, 2500);
  }

  function nearestOk(i) {
    if (ok[i]) return i;
    for (var d = 1; d < STAGES; d++) {
      if (ok[i - d]) return i - d;
      if (ok[i + d]) return i + d;
    }
    return -1;
  }

  /* ---------------------------------------------------------------- film: painting */
  function sizeCanvas() {
    if (!canvas || !stage) return;
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; painted = -1; }
  }

  function drawCover(im, alpha, push) {
    if (!im || !im.naturalWidth) return;
    var cw = canvas.width, ch = canvas.height;
    var s = Math.max(cw / im.naturalWidth, ch / im.naturalHeight) * zoom * (1 + KEN * push);
    var w = im.naturalWidth * s, h = im.naturalHeight * s;
    ctx.globalAlpha = alpha;
    ctx.drawImage(im, (cw - w) / 2, (ch - h) * anchorY, w, h);
    ctx.globalAlpha = 1;
  }

  /* t is a float 0..STAGES-1: integer part is the stage, fraction is the dissolve */
  function paint(t, force) {
    if (!ctx || !canvas.width) return;
    if (!force && Math.abs(t - painted) < 0.004) return;
    painted = t;
    var i = Math.min(STAGES - 2, Math.floor(t));
    if (t >= STAGES - 1) i = STAGES - 2;
    var f = clamp(t - i, 0, 1);
    var mix = smoothstep(f, HOLD, 1 - HOLD * 0.4);
    var a = nearestOk(i), b = nearestOk(i + 1);
    ctx.fillStyle = "#0f1010"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (a >= 0) drawCover(imgs[a], 1, f);
    if (b >= 0 && mix > 0.001) drawCover(imgs[b], mix, f - 1);
  }

  /* ---------------------------------------------------------------- film: chrome */
  function applyChromeTone(t, fade) {
    if (!header) return;
    var table = (FILM[setKey] || FILM.d).topLum;
    var i = clamp(Math.floor(t), 0, STAGES - 2), f = clamp(t - i, 0, 1);
    var lum = table[i] * (1 - f) + table[i + 1] * f;
    lum = lum * (1 - fade) + GROUND_LUM * fade;   /* the film fades into the dark ground at the end */
    if (lastLum >= 0 && Math.abs(lum - lastLum) < 6) return;
    lastLum = lum;
    var dark = lum > LUM_SWITCH;
    header.classList.toggle("on-light", dark);
    if (readout) readout.classList.toggle("dark", dark);
  }

  function beatAlpha(b, p) {
    if (p < b.a || p > b.b) return 0;
    if (p < b.peak) return (p - b.a) / Math.max(1e-4, b.peak - b.a);
    if (b.b > 1.5) return 1;
    return 1 - (p - b.peak) / Math.max(1e-4, b.b - b.peak);
  }

  function updateBeats(p) {
    for (var i = 0; i < beats.length; i++) {
      var b = beats[i], raw = clamp(beatAlpha(b, p), 0, 1);
      var e = raw * raw * (3 - 2 * raw);
      if (Math.abs(e - b.op) < 0.008) continue;
      var rising = p < b.peak;
      b.op = e;
      b.el.style.opacity = e.toFixed(3);
      b.el.style.transform = "translate3d(0," + ((1 - e) * (rising ? 16 : -12)).toFixed(1) + "px,0)";
      b.el.style.visibility = e > 0.004 ? "visible" : "hidden";
      b.el.style.pointerEvents = e > 0.6 ? "auto" : "none";
    }
  }

  function updateFilmChrome(p) {
    var f = clamp((p - 0.945) / 0.055, 0, 1);
    applyChromeTone(p * (STAGES - 1), f);
    if (Math.abs(f - lastFade) > 0.008) {
      lastFade = f;
      if (fadeEl) fadeEl.style.opacity = f.toFixed(3);
      if (scrimEl) scrimEl.style.opacity = (1 - f).toFixed(3);
      if (vignEl) vignEl.style.opacity = (1 - f).toFixed(3);
    }
    var idx = clamp(Math.round(p * (STAGES - 1)), 0, STAGES - 1);
    var txt = "0" + (idx + 1) + " / 0" + STAGES;
    if (txt !== lastStageTxt && readoutStage) { lastStageTxt = txt; readoutStage.textContent = txt; }
    if (idx !== lastStageIdx) {
      lastStageIdx = idx;
      if (readoutName) readoutName.textContent = STAGE_NAMES[idx];
      for (var i = 0; i < ticks.length; i++) {
        ticks[i].classList.toggle("on", i <= idx);
        ticks[i].classList.toggle("now", i === idx);
      }
    }
    if (readoutBar && Math.abs(p - lastBar) > 0.004) { lastBar = p; readoutBar.style.transform = "scaleX(" + p.toFixed(3) + ")"; }
  }

  /* ---------------------------------------------------------------- tick */
  function tick(now) {
    var dt = Math.min(100, now - (lastTick || now)); lastTick = now;
    if (JANK) {
      if (dt > jankMax) jankMax = dt;
      if (now - jankAt > 2000) { console.log("jank max ms", Math.round(jankMax)); jankMax = 0; jankAt = now; }
    }
    current += (target - current) * (1 - Math.pow(1 - 0.16, dt / 16.667));
    if (Math.abs(target - current) < 0.002) current = target;
    paint(current, false);
    if (current === target) { rafId = null; lastTick = 0; return; }
    rafId = requestAnimationFrame(tick);
  }

  function onFilmScroll() {
    var p = progress();
    target = p * (STAGES - 1);
    if (rafId === null) rafId = requestAnimationFrame(tick);
    updateBeats(p);
    updateFilmChrome(p);
  }

  /* ---------------------------------------------------------------- static mode */
  function goStatic() {
    filmOn = false;
    if (!film) return;
    film.classList.add("static");
    film.classList.remove("live");
    if (poster && posterSrc) poster.src = posterSrc;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    /* the static poster is the finished house under a bright overcast sky, so the fixed chrome
       sitting over it needs the dark treatment, not the light one */
    if (header) header.classList.add("on-light");
    if (readout) readout.classList.add("dark");
    markHeadings(true);
    if (STILL) {
      /* Capture harnesses run the page inside a very tall iframe, which makes 1svh enormous and
         throws every svh-based offset off the stage. Pin the stage and the beat in real pixels. */
      var hp = Math.min(win.innerHeight, win.innerWidth < 900 ? 780 : 880);
      if (filmScroll) filmScroll.style.height = hp + "px";
      if (stage) stage.style.height = hp + "px";
      var sb = film.querySelector(".beat-static");
      if (sb) sb.style.bottom = (win.innerWidth < 900 ? 56 : 72) + "px";
    }
    markReady();
  }

  function startFilm() {
    if (!film) { markReady(); return; }
    setKey = pickSet();
    dir = FILM[setKey].dir; posterSrc = FILM[setKey].poster;
    zoom = FILM[setKey].zoom; anchorY = FILM[setKey].anchorY;
    if (reduced()) { if (poster) poster.src = posterSrc; goStatic(); return; }
    /* The static poster is the finished house, which is the right picture for a visitor who will
       never see the film. As the film's own placeholder it is wrong: the hero would show a finished
       house and then jump back to an empty lot. While the film is running, the placeholder is its
       own first frame, which is also one fewer image on the critical path. */
    if (poster) poster.src = dir + "1.jpg";
    markHeadings(false);
    film.classList.remove("static", "loaded", "live");
    if (filmScroll) filmScroll.style.height = "";
    if (stage) stage.style.height = "";
    filmOn = true;
    sizeCanvas();
    var p = progress();
    target = current = p * (STAGES - 1);
    updateBeats(p); updateFilmChrome(p);
    loadFilm();
  }

  function swapSetIfNeeded() {
    if (!filmOn) return;
    var k = pickSet();
    if (k === setKey) return;
    setKey = k; dir = FILM[k].dir; posterSrc = FILM[k].poster;
    zoom = FILM[k].zoom; anchorY = FILM[k].anchorY;
    if (poster) poster.src = posterSrc;
    loadFilm();
  }

  function markReady() {
    if (readyFired) return;
    readyFired = true;
    if (JUMP !== null) {
      win.scrollTo(0, +JUMP || 0);
      if (filmOn) { var p = progress(); target = current = p * (STAGES - 1); paint(current, true); updateBeats(p); updateFilmChrome(p); }
      onScroll();
    }
    win.__ready = true;
  }

  win.__film = {
    get p() { return progress(); },
    get stage() { return Math.round(current) + 1; },
    get set() { return setKey; },
    get on() { return filmOn; }
  };

  /* ---------------------------------------------------------------- global scroll */
  var lastY = 0, headerHidden = false;
  function onScroll() {
    var y = win.scrollY;
    if (filmOn) onFilmScroll();

    if (header && filmScroll) {
      var r = filmScroll.getBoundingClientRect();
      header.classList.toggle("solid", r.bottom <= header.offsetHeight + 2);
    }
    if (progressBar) {
      var max = root.scrollHeight - win.innerHeight;
      progressBar.style.transform = "scaleX(" + (max > 0 ? clamp(y / max, 0, 1) : 0).toFixed(4) + ")";
    }
    /* Sticky phone call bar: appears once the film is behind you, and steps back out at the
       very bottom so it never sits over the footer's fine print. */
    if (callBar) {
      var past = filmScroll ? (filmScroll.getBoundingClientRect().bottom < 40) : y > 600;
      var atFoot = false;
      if (footEl) {
        var fr = footEl.getBoundingClientRect();
        atFoot = fr.top < win.innerHeight - 90;
      }
      var showBar = past && !atFoot;
      if (showBar !== callBarOn) { callBarOn = showBar; callBar.classList.toggle("show", showBar); }
    }
    lastY = y;
  }

  /* ---------------------------------------------------------------- headings: word rise */
  function splitHeadings() {
    $$(".section h2, .split-title").forEach(function (h) {
      if (h.dataset.split) return;
      var text = h.textContent.replace(/\s+/g, " ").trim();
      if (!text) return;
      h.setAttribute("aria-label", text);
      h.textContent = "";
      var frag = doc.createDocumentFragment();
      text.split(" ").forEach(function (w, i) {
        var m = doc.createElement("span"); m.className = "mask"; m.setAttribute("aria-hidden", "true");
        var s = doc.createElement("span"); s.textContent = w;
        s.style.transitionDelay = (i * 55) + "ms";
        m.appendChild(s); frag.appendChild(m);
        frag.appendChild(doc.createTextNode(" "));
      });
      h.appendChild(frag);
      h.dataset.split = "1";
    });
  }

  /* ---------------------------------------------------------------- sections */
  var sections = $$(".section");
  function pinSections() { sections.forEach(function (s) { s.classList.add("in", "settled"); s.classList.remove("out"); }); }

  var sectionIo = "IntersectionObserver" in win ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var s = e.target;
      if (e.isIntersecting) {
        if (!s.classList.contains("in")) {
          s.classList.add("in");
          win.setTimeout(function () { s.classList.add("settled"); }, 1500);
        }
        s.classList.remove("out");
      } else if (e.boundingClientRect.top < 0 && s.classList.contains("in")) {
        s.classList.add("out");
      }
    });
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }) : null;

  /* small elements that reveal on their own (brackets, rules, cards) */
  var revealIo = "IntersectionObserver" in win ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("drawn");
      revealIo.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.2 }) : null;

  /* ---------------------------------------------------------------- nav current */
  var navLinks = $$(".nav a, .menu a");
  var navIo = "IntersectionObserver" in win ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var id = "#" + e.target.id;
      navLinks.forEach(function (a) {
        var match = a.getAttribute("href") === id;
        if (match) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
      });
    });
  }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 }) : null;

  /* ---------------------------------------------------------------- menu */
  var menuBtn = $(".menu-btn"), menu = $("#menu");
  var mainEl = doc.getElementById("main"), footEl = $(".site-footer");
  function setMenu(open) {
    if (!menuBtn || !menu) return;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    menu.classList.toggle("open", open);
    body.classList.toggle("menu-open", open);
    menu.setAttribute("aria-modal", open ? "true" : "false");
    /* keep the rest of the page out of the tab order while the panel is over it */
    [mainEl, footEl].forEach(function (el) {
      if (!el) return;
      if (open) el.setAttribute("inert", ""); else el.removeAttribute("inert");
    });
    var label = $("span", menuBtn);
    if (label) label.textContent = open ? "Close" : "Menu";
    if (open) {
      var first = $("a", menu);
      if (first) win.setTimeout(function () { first.focus(); }, 60);
    } else {
      menuBtn.focus();
    }
  }
  /* focus trap, for browsers without inert */
  on(menu, "keydown", function (e) {
    if (e.key !== "Tab" || !menu.classList.contains("open")) return;
    var f = $$("a, button", menu).filter(function (el) { return el.offsetParent !== null; });
    f.push(menuBtn);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  on(menuBtn, "click", function () { setMenu(menuBtn.getAttribute("aria-expanded") !== "true"); });
  on(menu, "click", function (e) { if (e.target.closest("a")) setMenu(false); });

  /* ---------------------------------------------------------------- lightbox */
  var lb = $("#lightbox");
  var lbImg = lb && $("img", lb), lbCap = lb && $("figcaption", lb), lbClose = lb && $(".close", lb);
  var lbPrev = lb && $(".prev", lb), lbNext = lb && $(".next", lb), lbCount = lb && $(".count", lb);
  var shots = [], lbIndex = -1, lbOpener = null;

  function collectShots() { shots = $$(".work-grid button[data-full]"); }

  function showShot(i) {
    if (!lb || !shots.length) return;
    lbIndex = (i + shots.length) % shots.length;
    var btn = shots[lbIndex], im = $("img", btn);
    if (lbImg) { lbImg.src = btn.dataset.full; lbImg.alt = im ? im.alt : ""; }
    if (lbCap) lbCap.textContent = btn.dataset.caption || "";
    if (lbCount) lbCount.textContent = (lbIndex + 1) + " / " + shots.length;
  }

  function openLb(btn) {
    if (!lb) return;
    collectShots();
    lbOpener = btn;
    showShot(shots.indexOf(btn));
    lb.hidden = false;
    requestAnimationFrame(function () { lb.classList.add("open"); if (lbClose) lbClose.focus(); });
    body.style.overflow = "hidden";
  }

  function closeLb() {
    if (!lb || lb.hidden) return;
    lb.classList.remove("open");
    win.setTimeout(function () { lb.hidden = true; if (lbImg) lbImg.src = ""; }, reduced() ? 0 : 280);
    body.style.overflow = "";
    if (lbOpener) lbOpener.focus();
  }

  function wireWorkGrid() {
    collectShots();
    shots.forEach(function (b) {
      if (b.dataset.wired) return;
      b.dataset.wired = "1";
      on(b, "click", function () { openLb(b); });
    });
  }
  on(lbClose, "click", closeLb);
  on(lbPrev, "click", function () { showShot(lbIndex - 1); });
  on(lbNext, "click", function () { showShot(lbIndex + 1); });
  on(lb, "click", function (e) { if (e.target === lb) closeLb(); });

  /* trap focus inside the lightbox while it is open */
  on(doc, "keydown", function (e) {
    if (lb && !lb.hidden) {
      if (e.key === "Escape") { e.preventDefault(); closeLb(); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); showShot(lbIndex + 1); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); showShot(lbIndex - 1); return; }
      if (e.key === "Tab") {
        var f = $$("button, [href]", lb).filter(function (el) { return el.offsetParent !== null; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (e.key === "Escape" && menu && menu.classList.contains("open")) { setMenu(false); if (menuBtn) menuBtn.focus(); }
  });

  /* ---------------------------------------------------------------- work filter */
  function wireFilters() {
    var bar = $(".work-filter");
    if (!bar) return;
    var figures = $$(".work-grid figure");
    $$("button", bar).forEach(function (btn) {
      on(btn, "click", function () {
        var key = btn.dataset.filter || "all";
        $$("button", bar).forEach(function (b) { b.setAttribute("aria-pressed", b === btn ? "true" : "false"); });
        figures.forEach(function (fig) {
          var tags = (fig.dataset.tags || "").split(/\s+/);
          var show = key === "all" || tags.indexOf(key) > -1;
          fig.classList.toggle("hide", !show);
        });
        collectShots();
      });
    });
  }

  /* ---------------------------------------------------------------- the build slider */
  function wireBuilder() {
    var wrap = $("#builder");
    if (!wrap) return;
    var input = $("input[type=range]", wrap);
    var cv = $("canvas", wrap);
    var label = $(".builder-label", wrap);
    var stepEls = $$(".builder-steps li", wrap);
    if (!input || !cv) return;
    var bctx = cv.getContext("2d", { alpha: false });
    var bimgs = [], bok = [], bt = 0, btarget = 0, braf = null;
    var names = stepEls.map(function (li) { return li.textContent.trim(); });

    for (var i = 0; i < STAGES; i++) (function (n) {
      var im = new Image(); im.decoding = "async";
      im.onload = function () { bok[n] = true; if (n <= Math.ceil(bt)) bpaint(bt, true); };
      im.src = "assets/film/d" + (n + 1) + ".jpg";
      bimgs[n] = im;
    })(i);

    function bsize() {
      var w = wrap.clientWidth, h = Math.round(w * 9 / 16);
      var dpr = Math.min(2, win.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      cv.style.height = h + "px";
    }

    function bdraw(im, alpha) {
      if (!im || !im.naturalWidth) return;
      var cw = cv.width, ch = cv.height;
      var s = Math.max(cw / im.naturalWidth, ch / im.naturalHeight);
      var w = im.naturalWidth * s, h = im.naturalHeight * s;
      bctx.globalAlpha = alpha;
      bctx.drawImage(im, (cw - w) / 2, (ch - h) / 2, w, h);
      bctx.globalAlpha = 1;
    }

    function bnear(i) {
      if (bok[i]) return i;
      for (var d = 1; d < STAGES; d++) { if (bok[i - d]) return i - d; if (bok[i + d]) return i + d; }
      return -1;
    }

    function bpaint(t, force) {
      if (!cv.width) return;
      var i = Math.min(STAGES - 2, Math.floor(t)), f = clamp(t - i, 0, 1);
      var mix = smoothstep(f, 0.15, 0.85);
      bctx.fillStyle = "#0f1010"; bctx.fillRect(0, 0, cv.width, cv.height);
      var a = bnear(i), b = bnear(i + 1);
      if (a >= 0) bdraw(bimgs[a], 1);
      if (b >= 0 && mix > 0.002) bdraw(bimgs[b], mix);
      var shown = Math.round(t);
      if (label && names[shown]) label.textContent = names[shown];
      stepEls.forEach(function (li, n) {
        var on = n === shown;
        li.classList.toggle("on", on);
        li.setAttribute("aria-current", on ? "true" : "false");
      });
      /* a screen reader should hear the stage, not the raw slider number */
      if (names[shown]) input.setAttribute("aria-valuetext", "Stage " + (shown + 1) + " of " + STAGES + ", " + names[shown].toLowerCase());
    }

    function btick() {
      bt += (btarget - bt) * 0.2;
      if (Math.abs(btarget - bt) < 0.002) { bt = btarget; braf = null; bpaint(bt, true); return; }
      bpaint(bt, false);
      braf = requestAnimationFrame(btick);
    }

    function setFrom(v) {
      btarget = clamp(v, 0, STAGES - 1);
      if (reduced()) { bt = btarget; bpaint(bt, true); return; }
      if (braf === null) braf = requestAnimationFrame(btick);
    }

    on(input, "input", function () { setFrom(+input.value / 100 * (STAGES - 1)); });
    stepEls.forEach(function (li, n) {
      on(li, "click", function () { input.value = String(Math.round(n / (STAGES - 1) * 100)); setFrom(n); });
      if (!li.hasAttribute("tabindex")) li.tabIndex = 0;
      on(li, "keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); } });
    });
    on(win, "resize", function () { bsize(); bpaint(bt, true); });
    bsize(); bpaint(0, true);

    /* the first time it scrolls into view, run the build once so it invites a drag */
    if (revealIo && !reduced()) {
      var once = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          once.disconnect();
          var startAt = performance.now(), dur = 2600;
          (function run(now) {
            var k = clamp((now - startAt) / dur, 0, 1);
            var e2 = k * k * (3 - 2 * k);
            bt = btarget = e2 * (STAGES - 1);
            input.value = String(Math.round(e2 * 100));
            bpaint(bt, true);
            if (k < 1) requestAnimationFrame(run);
          })(startAt);
        });
      }, { threshold: 0.4 });
      once.observe(wrap);
    }
  }

  /* ---------------------------------------------------------------- cursor spotlight */
  function wireSpotlight() {
    if (!finePointer.matches || reduced()) return;
    $$("[data-spot]").forEach(function (el) {
      if (el.dataset.spotWired) return;
      el.dataset.spotWired = "1";
      on(el, "pointermove", function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
        el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
      });
      on(el, "pointerleave", function () { el.style.removeProperty("--mx"); el.style.removeProperty("--my"); });
    });
  }

  /* ---------------------------------------------------------------- hours */
  var DAY_HOURS = { 1: [7, 19], 2: [7, 19], 3: [7, 19], 4: [7, 19], 5: [7, 19], 6: [9, 17], 0: null };
  function wireHours() {
    var now = new Date(), day = now.getDay();
    $$(".hours tr").forEach(function (tr) { tr.classList.toggle("today", +tr.dataset.day === day); });
    var badge = $("[data-open-state]");
    if (!badge) return;
    var h = DAY_HOURS[day], mins = now.getHours() * 60 + now.getMinutes();
    var open = !!h && mins >= h[0] * 60 && mins < h[1] * 60;
    badge.textContent = open ? "Open now" : "Closed now";
    badge.setAttribute("data-open-state", open ? "open" : "closed");
  }

  /* ---------------------------------------------------------------- copy phone */
  function wireCopy() {
    $$("[data-copy]").forEach(function (btn) {
      on(btn, "click", function () {
        var text = btn.dataset.copy;
        var done = function () {
          var old = btn.getAttribute("data-label") || btn.textContent;
          btn.setAttribute("data-label", old);
          btn.textContent = "Copied";
          btn.classList.add("copied");
          win.setTimeout(function () { btn.textContent = old; btn.classList.remove("copied"); }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
        else done();
      });
    });
  }

  /* ---------------------------------------------------------------- form */
  var callBar = $(".call-bar"), callBarOn = false;

  /* Only one of the two hero headings is ever rendered (CSS swaps them on .film.static), so only
     one is ever in the accessibility tree. Mark the other explicitly so it is unambiguous. */
  function markHeadings(staticMode) {
    var heroBeat = film && $(".beat-hero", film);
    var staticBeat = film && $(".beat-static", film);
    if (heroBeat) heroBeat.setAttribute("aria-hidden", staticMode ? "true" : "false");
    if (staticBeat) staticBeat.setAttribute("aria-hidden", staticMode ? "false" : "true");
  }

  function wireForm() {
    var form = $("#enquiry");
    if (!form) return;
    var status = $("#form-status");
    var submit = $('button[type="submit"]', form);
    var msg = $("#f-msg");

    /* job chips prefill the message */
    $$("[data-job]").forEach(function (chip) {
      on(chip, "click", function () {
        if (!msg) return;
        var v = chip.dataset.job;
        var pressed = chip.getAttribute("aria-pressed") === "true";
        chip.setAttribute("aria-pressed", pressed ? "false" : "true");
        var parts = msg.value.split(/,\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
        var idx = parts.indexOf(v);
        if (pressed && idx > -1) parts.splice(idx, 1);
        else if (!pressed && idx === -1) parts.push(v);
        msg.value = parts.join(", ");
        msg.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });

    function showError(input, show) {
      var m = $('.err[data-for="' + input.id + '"]', form);
      if (m) m.hidden = !show;
      if (show) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    }
    function validate() {
      var okAll = true, first = null;
      ["f-name", "f-contact", "f-msg"].forEach(function (id) {
        var input = doc.getElementById(id);
        if (!input) return;
        var bad = !input.value.trim();
        showError(input, bad);
        if (bad && !first) first = input;
        if (bad) okAll = false;
      });
      if (first) first.focus();
      return okAll;
    }
    function setStatus(text, state) {
      if (!status) return;
      status.textContent = text;
      if (state) status.setAttribute("data-state", state); else status.removeAttribute("data-state");
    }
    on(form, "input", function (e) { if (e.target.getAttribute("aria-invalid") === "true") showError(e.target, false); });

    var openedAt = Date.now();
    function clearForm() {
      form.reset();
      $$("[data-job]", form).forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
    }

    on(form, "submit", function (e) {
      e.preventDefault();
      if (!validate()) { setStatus("Check the highlighted fields.", "bad"); return; }
      submit.disabled = true;
      setStatus("Sending...");

      var fd = new FormData(form);
      var payload = {
        name: String(fd.get("name") || "").trim(),
        contact: String(fd.get("contact") || "").trim(),
        message: String(fd.get("message") || "").trim(),
        _gotcha: fd.get("_gotcha") || "",
        _t: openedAt
      };

      /* The endpoint is a Cloudflare Pages Function. On a static preview host there is none, so a
         404 is expected and the honest answer is to say nothing was sent rather than fake a send. */
      var done = function (sent) {
        submit.disabled = false;
        if (sent) { clearForm(); setStatus("Sent. Thanks, we will get back to you.", "ok"); }
        else { clearForm(); setStatus("This is a preview, so nothing was sent. On the live site this reaches your inbox."); }
      };

      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = win.setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);

      win.fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        win.clearTimeout(timer);
        done(res.ok);
      }).catch(function () {
        win.clearTimeout(timer);
        done(false);
      });
    });
  }

  /* ---------------------------------------------------------------- ambient setting-out lines */
  function wireAmbient() {
    var layers = $$(".ambient, .ambient-lines");
    if (!layers.length) return;
    if (reduced()) { layers.forEach(function (l) { l.classList.add("drawn"); }); return; }
    win.setTimeout(function () { layers.forEach(function (l) { l.classList.add("drawn"); }); }, 120);
  }

  /* ---------------------------------------------------------------- reduced motion, live */
  function applyMotionMode() {
    var r = reduced();
    body.classList.toggle("rm", r);
    if (r) {
      pinSections();
      $$(".drawable, .bracket-frame, .rule, .ambient, .ambient-lines").forEach(function (el) { el.classList.add("drawn"); });
      goStatic();
    } else {
      startFilm();
    }
    onScroll();
  }
  on(rmq, "change", applyMotionMode);

  /* ---------------------------------------------------------------- resize */
  var resizeT = null;
  on(win, "resize", function () {
    sizeCanvas();
    if (filmOn) paint(current, true);
    win.clearTimeout(resizeT);
    resizeT = win.setTimeout(function () { swapSetIfNeeded(); sizeCanvas(); if (filmOn) paint(current, true); onScroll(); }, 140);
  });
  on(portraitQ, "change", function () { swapSetIfNeeded(); });

  /* ---------------------------------------------------------------- pause when hidden */
  on(doc, "visibilitychange", function () { body.classList.toggle("paused", doc.hidden); });

  /* ---------------------------------------------------------------- smooth anchors */
  on(doc, "click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute("href");
    if (!id || id === "#") return;
    var t = doc.querySelector(id);
    if (!t) return;
    e.preventDefault();
    var top = t.getBoundingClientRect().top + win.scrollY - (header ? header.offsetHeight - 1 : 0);
    win.scrollTo({ top: top, behavior: reduced() ? "auto" : "smooth" });
    if (t.id) history.replaceState(null, "", "#" + t.id);
  });

  /* ---------------------------------------------------------------- boot */
  function boot() {
    splitHeadings();
    wireWorkGrid();
    wireFilters();
    wireBuilder();
    wireSpotlight();
    wireHours();
    wireCopy();
    wireForm();
    wireAmbient();

    sections = $$(".section");
    if (sectionIo) sections.forEach(function (s) { sectionIo.observe(s); });
    if (revealIo) $$(".drawable, .section .bracket-frame, .section .rule").forEach(function (el) { revealIo.observe(el); });
    if (navIo) navLinks.forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) !== "#" || href === "#top") return;
      var t = doc.querySelector(href);
      if (t) navIo.observe(t);
    });

    body.classList.toggle("rm", reduced());
    if (reduced()) { pinSections(); $$(".drawable, .bracket-frame, .rule, .ambient, .ambient-lines").forEach(function (el) { el.classList.add("drawn"); }); }

    if (FORCE_P === null) on(win, "scroll", onScroll, { passive: true });
    startFilm();
    onScroll();
    if (FORCE_P !== null) {
      /* pin everything to the forced position so a capture shows the real middle of the film */
      pinSections();
      $$(".drawable, .bracket-frame, .rule, .ambient, .ambient-lines").forEach(function (el) { el.classList.add("drawn"); });
      var p0 = FORCE_P;
      target = current = p0 * (STAGES - 1);
      updateBeats(p0); updateFilmChrome(p0);
      win.setTimeout(function () {
        firstDrawn = true;
        if (film) film.classList.add("live");
        sizeCanvas(); paint(current, true); markReady();
      }, 1200);
    }
    if (reduced()) markReady();
    /* safety: never leave __ready unset */
    win.setTimeout(markReady, 5000);
  }

  if (doc.readyState === "loading") on(doc, "DOMContentLoaded", boot);
  else boot();
})();
