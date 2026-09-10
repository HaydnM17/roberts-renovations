/* Roberts Renovations, spec mockup.
   The hero is one continuous generated film of a house being built, scrubbed by scroll.
   Everything else on the page is below it. No dependencies, no build step.
   Every feature is guarded, so markup can arrive or disappear without breaking the rest. */
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
  /* One film, one file, both orientations. `poster` is the finished house, which is the right
     picture for a visitor who will never see the film. `first` is the film's own opening frame,
     which is the right placeholder while it streams: using the poster there would show a finished
     house and then jump back to a building site the moment the video arrived. */
  var FILM = {
    src: "assets/hero-film.mp4",
    poster: "assets/poster-d.jpg",
    first: "assets/film-first.jpg",
    bytes: 4393635
  };
  var STAGES = 8;
  var STAGE_NAMES = ["Digging out", "Excavated", "Foundation", "Framing", "Roof and wrap",
                     "Drywall and floors", "Siding and finishes", "Finished"];
  /* Measured brightness of the top strip at each stage, so the fixed chrome over the film knows
     whether to run dark or light without reading pixels back, which would taint the surface. */
  var TOP_LUM = [247, 248, 248, 245, 240, 241, 241, 241];
  var GROUND_LUM = 21;
  var LUM_SWITCH = 140;
  var SEAM = "#151513";

  /* The film plays itself once on arrival, so a visitor who never scrolls still sees the house
     go up. `to` is how far through the film the intro runs before handing control to scroll.
     Everything before that point is spent by the intro and is rebased out of the scroll range,
     because easing back to frame 0 on handoff would read as a rewind. See startIntro. */
  var INTRO = { to: 0.34, rate: 1.6, glide: 620, hold: 260 };

  var rmq = matchMedia("(prefers-reduced-motion: reduce)");
  var portraitQ = matchMedia("(orientation: portrait)");
  var finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  function reduced() { return rmq.matches || STILL; }

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var on = function (el, ev, fn, o) { if (el) el.addEventListener(ev, fn, o); };
  var off = function (el, ev, fn, o) { if (el) el.removeEventListener(ev, fn, o); };

  root.style.setProperty("--seam", SEAM);

  /* ---------------------------------------------------------------- nodes */
  var header = $(".site-header");
  var film = $("#film");
  var filmScroll = film && $(".film-scroll", film);
  var stage = film && $(".film-stage", film);
  var poster = film && $(".film-poster", film);
  var video = film && $(".film-video", film);
  var filmFg = film && $(".film-fg", film);
  var fadeEl = film && $(".film-fade", film);
  var scrimEl = film && $(".film-scrim", film);
  var vignEl = film && $(".film-vignette", film);
  var ring = film && $(".film-ring", film);
  var ringArc = ring && $("circle.arc", ring);
  var readout = film && $(".film-readout", film);
  var readoutStage = readout && $(".stage", readout);
  var readoutName = readout && $(".stage-name", readout);
  var readoutBar = readout && $(".bar i", readout);
  var ticks = readout ? $$(".tick", readout) : [];
  var progressBar = $(".progress");

  var beats = film ? $$(".beat[data-in]", film).map(function (el) {
    return { el: el, a: +el.dataset.in, peak: +el.dataset.peak, b: +el.dataset.out, op: -1 };
  }) : [];

  /* ---------------------------------------------------------------- state */
  var conf = FILM;
  var filmOn = false, videoReady = false, started = false, readyFired = false;
  var target = 0, shown = 0, rafId = null, lastTick = 0;
  var seekBusy = false, pendingTime = null;
  var lastLum = -1, lastFade = -1, lastStageTxt = "", lastBar = -1, lastStageIdx = -1;
  var jankMax = 0, jankAt = 0;
  var introRunning = false, introDone = false, introRaf = null, introBase = 0, introT0 = 0;

  /* Scroll drives the film from `introBase` to 1, not from 0 to 1. The intro consumes the first
     slice of the film and rebases it out of the range, so handing over never runs the house
     backwards. Before the intro has played, introBase is 0 and this is the plain mapping. */
  function progress() {
    if (FORCE_P !== null) return FORCE_P;
    if (!filmScroll) return 0;
    var r = filmScroll.getBoundingClientRect();
    var range = r.height - win.innerHeight;
    if (range <= 0) return introBase;
    var raw = clamp(-r.top / range, 0, 1);
    return introBase + (1 - introBase) * raw;
  }

  /* ---------------------------------------------------------------- the seek gate
     Never write currentTime while a seek is in flight. Un-gated seeks pile up and that is the
     whole difference between smooth and choppy. Coalesce to the newest target, issue exactly one
     follow-up when the seek lands, and reset on error so the gate can never deadlock. */
  function requestSeek(t) {
    if (!video || !video.duration || !videoReady) return;
    t = clamp(t, 0, Math.max(0, video.duration - 0.02));
    if (seekBusy) { pendingTime = t; return; }
    /* a write of the value it already holds may never fire 'seeked', which would jam the gate */
    if (Math.abs(t - video.currentTime) < 0.004) return;
    seekBusy = true;
    try { video.currentTime = t; } catch (e) { seekBusy = false; }
  }
  /* The occluding canvas only needs repainting when the frame under it actually changed. On a
     seek that is once per landed seek, which is already the right rate. During the opening run it
     would otherwise be called on every animation frame, so it is held to the film's own 24fps:
     painting the same frame twice costs a full pixel walk and buys nothing. */
  var lastOccl = 0;
  function occlUpdate(force) {
    if (!win.RROcclude || !win.RROcclude.ok) return;
    var now = performance.now();
    if (!force && now - lastOccl < 38) return;
    lastOccl = now;
    win.RROcclude.update();
  }

  on(video, "seeked", function () {
    seekBusy = false;
    occlUpdate(true);   /* a landed seek is always a new frame, and the gate already rate-limits it */
    if (pendingTime !== null) { var t = pendingTime; pendingTime = null; requestSeek(t); }
  });
  on(video, "error", function () {
    seekBusy = false; pendingTime = null;
    if (video && video.getAttribute("src")) failFilm();
  });

  /* ---------------------------------------------------------------- loading, streamed */
  function setRing(frac) {
    if (!ringArc) return;
    ringArc.style.strokeDashoffset = String(Math.round(126 * (1 - clamp(frac, 0, 1))));
  }

  function failFilm() {
    if (ring) ring.style.display = "none";
    goStatic();
  }

  function loadFilm() {
    if (started || !video || !conf) return;
    started = true;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var watchdog = win.setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);

    win.fetch(conf.src, ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
      if (!res.ok || !res.body || !win.ReadableStream) {
        /* no streaming available: fall back to a plain blob so it still works */
        return res.blob().then(function (b) { win.clearTimeout(watchdog); attach(b); });
      }
      var total = Number(res.headers.get("Content-Length")) || conf.bytes;
      var reader = res.body.getReader();
      var chunks = [], got = 0, lastPaint = 0;
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            win.clearTimeout(watchdog);
            setRing(1);
            attach(new Blob(chunks, { type: "video/mp4" }));
            return;
          }
          win.clearTimeout(watchdog);
          watchdog = win.setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
          chunks.push(r.value);
          got += r.value.length;
          var now = performance.now();
          if (now - lastPaint > 90) { lastPaint = now; setRing(got / total); }
          return pump();
        });
      })();
    }).catch(function () {
      win.clearTimeout(watchdog);
      failFilm();
    });
  }

  function attach(blob) {
    if (!video) return;
    var url = URL.createObjectURL(blob);
    on(video, "loadedmetadata", function () {
      videoReady = true;
      if (film) film.classList.add("loaded");
      /* the house has to be able to cover the name before the name is shown */
      if (win.RROcclude && filmFg) {
        win.RROcclude.init({ video: video, canvas: filmFg });
      }
      var p = progress();
      seekBusy = false; pendingTime = null;
      shown = target = p;
      /* seek before revealing, so the first frame anyone sees is the right one. A forced
         position waits for the seek to actually land, because a capture never runs the rAF
         loop that would otherwise drive it there. */
      if (FORCE_P !== null) {
        on(video, "seeked", function () {
          if (film) film.classList.add("live");
          win.setTimeout(markReady, 120);
        }, { once: true });
        requestSeek(p * video.duration);
        win.setTimeout(function () { if (film) film.classList.add("live"); markReady(); }, 2500);
      } else {
        requestSeek(p * video.duration);
        win.setTimeout(function () {
          if (film) film.classList.add("live");
          markReady();
          /* let the reveal land before the camera starts moving, or the fade in and the first
             seconds of the build happen on top of each other and neither reads */
          win.setTimeout(startIntro, INTRO.hold);
        }, 60);
      }
    }, { once: true });
    video.src = url;
    video.load();
  }

  /* ---------------------------------------------------------------- chrome */
  function applyChromeTone(p, fade) {
    if (!header) return;
    var t = p * (STAGES - 1);
    var i = clamp(Math.floor(t), 0, STAGES - 2), f = clamp(t - i, 0, 1);
    var lum = TOP_LUM[i] * (1 - f) + TOP_LUM[i + 1] * f;
    lum = lum * (1 - fade) + GROUND_LUM * fade;
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
    applyChromeTone(p, f);
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

  /* ---------------------------------------------------------------- tick
     Ease toward the scroll position rather than writing it straight in. The exponent normalises
     the smoothing to a 60fps reference so a 120Hz screen converges at the same speed. The loop
     rests the moment it has arrived. */
  function tick(now) {
    var dt = Math.min(100, now - (lastTick || now)); lastTick = now;
    if (JANK) {
      if (dt > jankMax) jankMax = dt;
      if (now - jankAt > 2000) { console.log("jank max ms", Math.round(jankMax)); jankMax = 0; jankAt = now; }
    }
    shown += (target - shown) * (1 - Math.pow(1 - 0.16, dt / 16.667));
    if (Math.abs(target - shown) < 0.0004) shown = target;
    if (videoReady && video.duration) requestSeek(shown * video.duration);
    if (shown === target) { rafId = null; lastTick = 0; return; }
    rafId = requestAnimationFrame(tick);
  }

  /* ---------------------------------------------------------------- the opening run
     The film plays itself the moment it is ready, so the house is already going up before the
     visitor touches anything. Two things make this safe to hand back from.

     One: the intro uses native playback, never the seek gate. Seeking at 24fps would fight the
     gate and stutter; play() is what the decoder is for. Nothing here writes currentTime, so the
     gate stays clean and the handoff needs no unwinding.

     Two: on handoff the position it reached becomes the new floor of the scroll range, via
     introBase in progress(). Without that, letting go at 34% with the page still at scrollTop 0
     would ease the film back to an empty lot, which reads as a rewind and undoes the point. */
  function introAllowed() {
    if (!video || !filmOn || introDone || introRunning) return false;
    if (reduced() || STILL || FORCE_P !== null || JUMP !== null) return false;
    if (win.scrollY > 8) return false;          /* already reading, do not yank them back */
    if (doc.hidden) return false;               /* a background tab would burn the whole intro */
    var c = win.navigator.connection;
    if (c && (c.saveData || /2g/.test(c.effectiveType || ""))) return false;
    return true;
  }

  function introFrame() {
    if (!introRunning) return;
    var dur = video.duration || 0;
    if (!dur) { introRaf = requestAnimationFrame(introFrame); return; }
    var p = clamp(video.currentTime / dur, 0, 1);
    updateBeats(p); updateFilmChrome(p);
    occlUpdate();
    if (p >= INTRO.to) { endIntro("arrived"); return; }
    introRaf = requestAnimationFrame(introFrame);
  }

  /* Ramp the rate down rather than cutting playback, so the last thing the eye sees is the
     camera settling rather than a stop. Then pause on the frame it settled on. */
  function glideOut(then) {
    var from = video.playbackRate || 1, t0 = performance.now();
    (function step(now) {
      var k = clamp((now - t0) / INTRO.glide, 0, 1);
      var e = 1 - Math.pow(1 - k, 3);
      try { video.playbackRate = Math.max(0.06, from * (1 - e)); } catch (err) {}
      if (k < 1) { introRaf = requestAnimationFrame(step); return; }
      try { video.pause(); video.playbackRate = 1; } catch (err) {}
      then();
    })(t0);
  }

  function endIntro(why) {
    if (!introRunning) return;
    introRunning = false;
    introDone = true;
    if (introRaf !== null) { cancelAnimationFrame(introRaf); introRaf = null; }
    off(win, "scroll", introBail);
    off(win, "wheel", introBail);
    off(win, "touchstart", introBail);
    off(win, "keydown", introKey);

    var settle = function () {
      var dur = video.duration || 0;
      /* rebase before reading progress(), so target and shown both come out at the frame that
         is already on screen and the easing loop has nothing to travel */
      introBase = dur ? clamp(video.currentTime / dur, 0, 0.92) : 0;
      seekBusy = false; pendingTime = null;
      var p = progress();
      shown = target = p;
      updateBeats(p); updateFilmChrome(p);
      if (film) film.classList.remove("intro");
    };

    /* a bail is a person reaching for the page: stop now. Arriving on its own gets the ramp. */
    if (why === "arrived") glideOut(settle);
    else { try { video.pause(); video.playbackRate = 1; } catch (e) {} settle(); }
  }

  function introBail() { endIntro("bail"); }
  function introKey(e) {
    var k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "PageDown" || k === "PageUp" ||
        k === " " || k === "Home" || k === "End") endIntro("bail");
  }

  function startIntro() {
    if (!introAllowed()) return;
    introRunning = true;
    introT0 = performance.now();
    if (film) film.classList.add("intro");
    try {
      video.currentTime = 0;
      video.playbackRate = INTRO.rate;
    } catch (e) {}
    var pr;
    try { pr = video.play(); } catch (e) { pr = null; }
    /* autoplay can still be refused even muted. If it is, drop the intro and leave scroll in
       charge rather than leaving the film parked on frame 0 with a class that says otherwise. */
    if (pr && typeof pr.catch === "function") {
      pr.catch(function () {
        introRunning = false; introDone = true;
        if (film) film.classList.remove("intro");
        off(win, "scroll", introBail); off(win, "wheel", introBail);
        off(win, "touchstart", introBail); off(win, "keydown", introKey);
        var p = progress(); shown = target = p;
        requestSeek(p * (video.duration || 0));
      });
    }
    on(win, "scroll", introBail, { passive: true, once: true });
    on(win, "wheel", introBail, { passive: true, once: true });
    on(win, "touchstart", introBail, { passive: true, once: true });
    on(win, "keydown", introKey);
    introRaf = requestAnimationFrame(introFrame);
    /* hard ceiling: if the decoder stalls, never hold the page hostage */
    win.setTimeout(function () { if (introRunning) endIntro("timeout"); }, 14000);
  }

  /* ---------------------------------------------------------------- modes */
  function goStatic() {
    if (introRunning) endIntro("bail");
    filmOn = false;
    if (!film) { markReady(); return; }
    film.classList.add("static");
    film.classList.remove("live");
    if (poster && conf) poster.src = conf.poster;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    /* the poster is the finished house under a bright sky, so the chrome over it runs dark */
    if (header) header.classList.add("on-light");
    if (readout) readout.classList.add("dark");
    markHeadings(true);
    if (STILL) {
      /* a capture harness runs the page in a very tall iframe, which makes svh enormous and
         throws every svh offset off the stage, so pin it in real pixels */
      var hp = Math.min(win.innerHeight, win.innerWidth < 900 ? 780 : 880);
      if (filmScroll) filmScroll.style.height = hp + "px";
      if (stage) stage.style.height = hp + "px";
      var sb = $(".beat-static", film);
      if (sb) sb.style.bottom = (win.innerWidth < 900 ? 56 : 72) + "px";
    }
    markReady();
  }

  function startFilm() {
    if (!film) { markReady(); return; }
    if (reduced()) { goStatic(); return; }
    if (poster) poster.src = conf.first;
    markHeadings(false);
    film.classList.remove("static");
    if (filmScroll) filmScroll.style.height = "";
    if (stage) stage.style.height = "";
    filmOn = true;
    var p = progress();
    shown = target = p;
    updateBeats(p); updateFilmChrome(p);
    /* let the poster win the bandwidth race, then stream the film in behind it */
    var img = new Image();
    var kick = function () { loadFilm(); };
    img.onload = kick; img.onerror = kick;
    img.src = conf.first;
    win.setTimeout(kick, 3000);
  }

  function markHeadings(staticMode) {
    var heroBeat = film && $(".beat-hero", film);
    var staticBeat = film && $(".beat-static", film);
    if (heroBeat) heroBeat.setAttribute("aria-hidden", staticMode ? "true" : "false");
    if (staticBeat) staticBeat.setAttribute("aria-hidden", staticMode ? "false" : "true");
  }

  function markReady() {
    if (readyFired) return;
    readyFired = true;
    if (JUMP !== null) {
      win.scrollTo(0, +JUMP || 0);
      onScroll();
    }
    win.__ready = true;
  }

  win.__film = {
    get p() { return progress(); },
    get t() { return video ? video.currentTime : -1; },
    get dur() { return video ? video.duration : -1; },
    get on() { return filmOn; },
    get ready() { return videoReady; },
    get intro() { return { running: introRunning, done: introDone, base: introBase }; },
    skipIntro: function () { endIntro("bail"); }
  };

  /* ---------------------------------------------------------------- global scroll */
  var callBar = null, callBarOn = false, footEl = null;

  function onScroll() {
    var y = win.scrollY;
    /* while the intro is playing the decoder owns the playhead. Driving seeks at it here would
       fight native playback and stutter. The bail listener ends the intro on this same event, so
       the very next scroll lands in the branch below with the position already rebased. */
    if (filmOn && !introRunning) {
      var p = progress();
      target = p;
      if (rafId === null) rafId = requestAnimationFrame(tick);
      updateBeats(p);
      updateFilmChrome(p);
    }
    if (header && filmScroll) {
      var r = filmScroll.getBoundingClientRect();
      header.classList.toggle("solid", r.bottom <= header.offsetHeight + 2);
    }
    if (progressBar) {
      var max = root.scrollHeight - win.innerHeight;
      progressBar.style.transform = "scaleX(" + (max > 0 ? clamp(y / max, 0, 1) : 0).toFixed(4) + ")";
    }
    if (callBar) {
      var past = filmScroll ? (filmScroll.getBoundingClientRect().bottom < 40) : y > 600;
      var atFoot = false;
      if (footEl) atFoot = footEl.getBoundingClientRect().top < win.innerHeight - 90;
      var showBar = past && !atFoot;
      if (showBar !== callBarOn) { callBarOn = showBar; callBar.classList.toggle("show", showBar); }
    }
    envFilmScroll();
  }

  /* ---------------------------------------------------------------- the environment film
     The same house, circling, behind every section below the hero. It is one seamless loop and
     it is the page's only background, so it plays on its own and is never scrubbed.

     It does not exist until the visitor is near the end of the hero. Two reasons: the hero film
     is 4.4 MB and must not share the pipe with anything, and a fixed blurred video decoding
     behind an opaque hero is work nobody can see. */
  var envEl = null, envVideo = null, envAsked = false, envOn = false;

  function envFilmScroll() {
    if (!envVideo || reduced()) return;
    var near, past;
    if (filmScroll) {
      var r = filmScroll.getBoundingClientRect();
      near = r.bottom < win.innerHeight * 2.2;   /* start fetching a screen or so early */
      past = r.bottom < win.innerHeight * 0.9;   /* the hero has largely left, show it */
    } else {
      near = win.scrollY > 200; past = win.scrollY > 600;
    }
    if (near && !envAsked) {
      envAsked = true;
      envVideo.src = "assets/orbit.mp4";
      envVideo.load();
    }
    if (past === envOn) return;
    envOn = past;
    envEl.classList.toggle("film-on", past);
    /* nothing is gained by decoding it while it is invisible behind the hero */
    if (past) { var pr = envVideo.play(); if (pr && pr.catch) pr.catch(function () {}); }
    else { try { envVideo.pause(); } catch (e) {} }
  }

  /* headless cannot scroll and does not composite a video layer, so the only way to prove this
     layer works is to drive it from the console and read the element back */
  win.__env = {
    get asked() { return envAsked; },
    get on() { return envOn; },
    get ready() { return !!(envEl && envEl.classList.contains("film-ready")); },
    get readyState() { return envVideo ? envVideo.readyState : -1; },
    get paused() { return envVideo ? envVideo.paused : null; },
    get t() { return envVideo ? envVideo.currentTime : -1; },
    get dur() { return envVideo ? envVideo.duration : -1; },
    force: function () {
      if (!envVideo) return false;
      envAsked = true;
      envVideo.src = "assets/orbit.mp4";
      envVideo.load();
      envOn = true;
      envEl.classList.add("film-on");
      var pr = envVideo.play();
      if (pr && pr.catch) pr.catch(function () {});
      return true;
    }
  };

  function wireEnvFilm() {
    envEl = $(".env");
    envVideo = envEl && $(".env-film", envEl);
    if (!envEl || !envVideo) return;
    var c = win.navigator.connection;
    /* on a metered or slow connection the gradient is a perfectly good background */
    if ((c && (c.saveData || /2g/.test(c.effectiveType || ""))) || reduced() || STILL) return;
    /* loadeddata is the honest gate, because it means a frame exists to show. canplay is listened
       for as well only because a browser that skips one usually still fires the other, and the
       cost of arriving twice is a class that is already set. */
    var ready = function () { envEl.classList.add("film-ready"); };
    on(envVideo, "loadeddata", ready);
    on(envVideo, "canplay", ready);
    on(envVideo, "error", function () { envEl.classList.remove("film-ready", "film-on"); });
    /* a paused tab should not hold a decoder open */
    on(doc, "visibilitychange", function () {
      if (!envOn) return;
      if (doc.hidden) { try { envVideo.pause(); } catch (e) {} }
      else { var pr = envVideo.play(); if (pr && pr.catch) pr.catch(function () {}); }
    });
  }

  /* ---------------------------------------------------------------- headings: word rise */
  function splitHeadings() {
    $$(".section h2").forEach(function (h) {
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
  var sections = [];
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

  var revealIo = "IntersectionObserver" in win ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add("drawn");
      revealIo.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.2 }) : null;

  /* ---------------------------------------------------------------- nav current */
  var navLinks = [];
  var navIo = "IntersectionObserver" in win ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var id = "#" + e.target.id;
      navLinks.forEach(function (a) {
        if (a.getAttribute("href") === id) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    });
  }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 }) : null;

  /* ---------------------------------------------------------------- menu */
  var menuBtn = $(".menu-btn"), menu = $("#menu"), mainEl = doc.getElementById("main");
  function setMenu(open) {
    if (!menuBtn || !menu) return;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    menu.classList.toggle("open", open);
    body.classList.toggle("menu-open", open);
    menu.setAttribute("aria-modal", open ? "true" : "false");
    [mainEl, footEl].forEach(function (el) {
      if (!el) return;
      if (open) el.setAttribute("inert", ""); else el.removeAttribute("inert");
    });
    var label = $("span", menuBtn);
    if (label) label.textContent = open ? "Close" : "Menu";
    if (open) {
      var first = $("a", menu);
      if (first) win.setTimeout(function () { first.focus(); }, 60);
    } else { menuBtn.focus(); }
  }
  on(menuBtn, "click", function () { setMenu(menuBtn.getAttribute("aria-expanded") !== "true"); });
  on(menu, "click", function (e) { if (e.target.closest("a")) setMenu(false); });
  on(menu, "keydown", function (e) {
    if (e.key !== "Tab" || !menu.classList.contains("open")) return;
    var f = $$("a, button", menu).filter(function (el) { return el.offsetParent !== null; });
    f.push(menuBtn);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------------------------------------------------------------- lightbox */
  var lb = $("#lightbox");
  var lbImg = lb && $("img", lb), lbCap = lb && $("figcaption", lb), lbClose = lb && $(".close", lb);
  var lbPrev = lb && $(".prev", lb), lbNext = lb && $(".next", lb), lbCount = lb && $(".count", lb);
  var shots = [], lbIndex = -1, lbOpener = null;

  function collectShots() {
    shots = $$(".work-grid button[data-full]").filter(function (b) {
      var fig = b.closest("figure");
      return !fig || !fig.classList.contains("hide");
    });
  }
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
    $$(".work-grid button[data-full]").forEach(function (b) {
      if (b.dataset.wired) return;
      b.dataset.wired = "1";
      on(b, "click", function () { openLb(b); });
    });
  }
  on(lbClose, "click", closeLb);
  on(lbPrev, "click", function () { showShot(lbIndex - 1); });
  on(lbNext, "click", function () { showShot(lbIndex + 1); });
  on(lb, "click", function (e) { if (e.target === lb) closeLb(); });

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
          fig.classList.toggle("hide", !(key === "all" || tags.indexOf(key) > -1));
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
    /* the steps carry their own pictures now, so this drives whatever the markup lists rather
       than a fixed run of eight generated frames */
    var N = stepEls.length;
    var noteEl = $(".builder-note", wrap);
    var goBtn = $("[data-go]", wrap);
    if (N < 2) return;

    for (var i = 0; i < N; i++) (function (n) {
      var im = new Image(); im.decoding = "async";
      im.onload = function () { bok[n] = true; if (n <= Math.ceil(bt) + 1) bpaint(bt, true); };
      im.src = stepEls[n].getAttribute("data-img") || "";
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
      for (var d = 1; d < N; d++) { if (bok[i - d]) return i - d; if (bok[i + d]) return i + d; }
      return -1;
    }
    function bpaint(t, force) {
      if (!cv.width) return;
      var i = Math.min(N - 2, Math.floor(t)), f = clamp(t - i, 0, 1);
      var e = clamp((f - 0.15) / 0.7, 0, 1);
      var mix = e * e * (3 - 2 * e);
      bctx.fillStyle = "#0f1010"; bctx.fillRect(0, 0, cv.width, cv.height);
      var a = bnear(i), b = bnear(i + 1);
      if (a >= 0) bdraw(bimgs[a], 1);
      if (b >= 0 && mix > 0.002) bdraw(bimgs[b], mix);
      var idx = Math.round(t);
      if (label && names[idx]) label.textContent = names[idx];
      if (noteEl && stepEls[idx]) {
        var nt = stepEls[idx].getAttribute("data-note");
        if (nt && noteEl.textContent !== nt) noteEl.textContent = nt;
      }
      stepEls.forEach(function (li, n) {
        var isOn = n === idx;
        li.classList.toggle("on", isOn);
        li.setAttribute("aria-current", isOn ? "true" : "false");
      });
      if (names[idx]) input.setAttribute("aria-valuetext", "Stage " + (idx + 1) + " of " + N + ", " + names[idx].toLowerCase());
    }
    function btick() {
      bt += (btarget - bt) * 0.2;
      if (Math.abs(btarget - bt) < 0.002) { bt = btarget; braf = null; bpaint(bt, true); return; }
      bpaint(bt, false);
      braf = requestAnimationFrame(btick);
    }
    function setFrom(v) {
      btarget = clamp(v, 0, N - 1);
      if (reduced()) { bt = btarget; bpaint(bt, true); return; }
      if (braf === null) braf = requestAnimationFrame(btick);
    }
    on(input, "input", function () { setFrom(+input.value / 100 * (N - 1)); });
    stepEls.forEach(function (li, n) {
      on(li, "click", function () { input.value = String(Math.round(n / (N - 1) * 100)); setFrom(n); });
      if (!li.hasAttribute("tabindex")) li.tabIndex = 0;
      on(li, "keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); } });
    });
    on(win, "resize", function () { bsize(); bpaint(bt, true); });
    bsize(); bpaint(0, true);

    /* Carry the choice into the form rather than making them describe it twice. It presses the
       matching job chip and drops a first line in the message, but only when the box is still
       empty, because overwriting something a visitor has already typed is unforgivable. */
    on(goBtn, "click", function () {
      var li = stepEls[Math.round(bt)];
      if (!li) return;
      var job = li.getAttribute("data-job") || li.textContent.trim();
      var chip = doc.querySelector('.job-chips [data-job="' + job + '"]');
      if (chip && chip.getAttribute("aria-pressed") !== "true") chip.click();
      var msg = doc.getElementById("f-msg");
      if (msg && !msg.value.trim()) msg.value = job + ". ";
      var target = doc.getElementById("contact");
      if (target) {
        var top = target.getBoundingClientRect().top + win.scrollY - (header ? header.offsetHeight - 1 : 0);
        win.scrollTo({ top: top, behavior: reduced() ? "auto" : "smooth" });
      }
      /* focus lands after the scroll so the browser does not fight it to the same place */
      win.setTimeout(function () { if (msg) msg.focus({ preventScroll: true }); }, reduced() ? 0 : 620);
    });

    if ("IntersectionObserver" in win && !reduced()) {
      var once = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          once.disconnect();
          /* Sweep out and come back. On the old slider this ran one way because the last frame
             was the finished house and that was the payoff. This is a picker, so it has to end
             where a visitor would want to start rather than parked on the last option. */
          var startAt = performance.now(), dur = 3400;
          (function run(now) {
            var k = clamp((now - startAt) / dur, 0, 1);
            var out = k < 0.62 ? k / 0.62 : 1 - (k - 0.62) / 0.38;
            var e2 = out * out * (3 - 2 * out);
            bt = btarget = e2 * (N - 1);
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

  /* ---------------------------------------------------------------- copy */
  function wireCopy() {
    $$("[data-copy]").forEach(function (btn) {
      on(btn, "click", function () {
        var done = function () {
          var old = btn.getAttribute("data-label") || btn.textContent;
          btn.setAttribute("data-label", old);
          btn.textContent = "Copied";
          btn.classList.add("copied");
          win.setTimeout(function () { btn.textContent = old; btn.classList.remove("copied"); }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(btn.dataset.copy).then(done).catch(done);
        else done();
      });
    });
  }

  /* ---------------------------------------------------------------- form */
  function wireForm() {
    var form = $("#enquiry");
    if (!form) return;
    var status = $("#form-status");
    var submit = $('button[type="submit"]', form);
    var msg = $("#f-msg");
    var openedAt = Date.now();

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
    function clearForm() {
      form.reset();
      $$("[data-job]", form).forEach(function (c) { c.setAttribute("aria-pressed", "false"); });
    }
    on(form, "input", function (e) { if (e.target.getAttribute("aria-invalid") === "true") showError(e.target, false); });
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
      var done = function (sent) {
        submit.disabled = false;
        clearForm();
        if (sent) setStatus("Sent. Thanks, we will get back to you.", "ok");
        else setStatus("This is a preview, so nothing was sent. On the live site this reaches your inbox.");
      };
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var timer = win.setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
      win.fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) { win.clearTimeout(timer); done(res.ok); })
        .catch(function () { win.clearTimeout(timer); done(false); });
    });
  }

  /* ---------------------------------------------------------------- ambient */
  function wireAmbient() {
    var layers = $$(".ambient, .ambient-lines");
    if (!layers.length) return;
    var go = function () { layers.forEach(function (l) { l.classList.add("drawn"); }); };
    if (reduced()) go(); else win.setTimeout(go, 120);
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
      started = false; videoReady = false;
      startFilm();
    }
    onScroll();
  }
  on(rmq, "change", applyMotionMode);

  /* ---------------------------------------------------------------- resize */
  var resizeT = null;
  on(win, "resize", function () {
    win.clearTimeout(resizeT);
    resizeT = win.setTimeout(function () {
      onScroll();
    }, 160);
  });

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
    footEl = $(".site-footer");
    callBar = $(".call-bar");
    navLinks = $$(".nav a, .menu a");
    sections = $$(".section");

    splitHeadings();
    wireWorkGrid();
    wireFilters();
    wireBuilder();
    wireSpotlight();
    wireHours();
    wireCopy();
    wireForm();
    wireAmbient();
    wireEnvFilm();

    if (sectionIo) sections.forEach(function (s) { sectionIo.observe(s); });
    if (revealIo) $$(".drawable, .section .bracket-frame, .section .rule").forEach(function (el) { revealIo.observe(el); });
    if (navIo) navLinks.forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) !== "#" || href === "#top") return;
      var t = doc.querySelector(href);
      if (t) navIo.observe(t);
    });

    body.classList.toggle("rm", reduced());
    if (reduced()) {
      pinSections();
      $$(".drawable, .bracket-frame, .rule, .ambient, .ambient-lines").forEach(function (el) { el.classList.add("drawn"); });
    }

    if (FORCE_P === null) on(win, "scroll", onScroll, { passive: true });
    startFilm();
    onScroll();

    if (FORCE_P !== null) {
      /* pin the page so a capture shows the real middle of the film */
      pinSections();
      $$(".drawable, .bracket-frame, .rule, .ambient, .ambient-lines").forEach(function (el) { el.classList.add("drawn"); });
      updateBeats(FORCE_P); updateFilmChrome(FORCE_P);
    }
    if (reduced()) markReady();
    win.setTimeout(markReady, 8000);
  }

  if (doc.readyState === "loading") on(doc, "DOMContentLoaded", boot);
  else boot();
})();
