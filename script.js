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

  /* Slow motion, and barely any of it. Half speed for about five seconds, covering a twentieth of
     the film. Enough to see the ground being broken and know the thing is alive, not enough to
     spend any of the build before the visitor has done anything. */
  var INTRO = { to: 0.05, rate: 0.5, glide: 1100, hold: 320 };

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
  /* the film moved into the fixed .env layer, so these are looked up on the document rather
     than inside the hero section they used to live in */
  var envLayer = $(".env");
  var poster = $(".film-poster");
  var video = $(".film-video");
  var filmFg = $(".film-fg");
  var fadeEl = $(".film-fade");

  var scrimEl = $(".film-scrim");
  var vignEl = $(".film-vignette");
  var ring = film && $(".film-ring", film);
  var ringArc = ring && $("circle.arc", ring);
  var readout = film && $(".film-readout", film);
  var readoutStage = readout && $(".stage", readout);
  var readoutName = readout && $(".stage-name", readout);
  var readoutBar = readout && $(".bar i", readout);
  var ticks = readout ? $$(".tick", readout) : [];
  var progressBar = $(".progress");

  /* .beat-hero is deliberately excluded. Every other beat is driven by how far through the film
     the scroll has got; the hero block instead rides the hero exit, so it starts leaving the
     moment you scroll rather than waiting for the film to reach a threshold. */
  var allBeats = film ? $$(".beat[data-in]", film).filter(function (el) {
    return !el.classList.contains("beat-hero");
  }).map(function (el) {
    return { el: el, a: +el.dataset.in, peak: +el.dataset.peak, b: +el.dataset.out, op: -1 };
  }) : [];

  /* Two clocks, not one, and the reason is the whole point of this block.

     The six service lines are a quick cycle that has to have STARTED while the
     hero is still on screen: the first one lands before the logo and the
     headline have finished leaving, and the second arrives while they are
     still on their way out. The hero is gone by two thirds of a screen
     (updateHeroExit), so anything that wants to overlap it has to be measured
     in screens.

     The film cannot supply that number. It is deliberately stretched across
     the whole document now, so on the film's clock the first two thirds of a
     screen is a rounding error and every caption landed several screens after
     the hero had gone. That was the complaint.

     .beat-final is the opposite case: it is the film's closing panel and
     belongs at the end of the film, so it keeps the film's clock. Splitting
     the list here rather than branching inside the paint loop means the loop
     never has to know which clock it is on. */
  var svcBeats = allBeats.filter(function (b) { return b.el.classList.contains("beat-svc"); });
  svcBeats.forEach(function (b) { b.rule = true; b.drawn = -1; });
  var filmBeats = allBeats.filter(function (b) { return !b.el.classList.contains("beat-svc"); });

  /* How many screens of scroll the whole service cycle occupies, and the
     number that matters most in this file.

     The hero section is exactly ONE screen tall. The film carries on as the
     background of the whole page, but the content sections start arriving at
     one screen down, and these captions live in the fixed hero layer above
     them. So anything still painting past one screen paints ON TOP of the
     section somebody is trying to read, which is exactly what it looked
     like: a couple of faded texts floating over the content. Running to 2.2
     screens also meant the last line landed well past the point where the
     page had visibly moved on, which read as a long empty scroll.

     1.05 is therefore a hard ceiling, not a taste setting: the whole cycle
     has to be finished by the time the first section is in view. That is
     what set the number of lines. Four fit at a readable pace inside it;
     six did not, and the two that had to go (framing and decks, ceilings
     and trim) are both named in the services section immediately below.
     If a line is ever added here, this number cannot simply grow to make
     room for it. */
  var SVC_SPAN = 1.05;

  /* ?sy=<screens> pretends the page is scrolled that many viewport heights
     down, without scrolling it. Headless capture cannot scroll (under a
     virtual time budget, programmatic scrollTo does nothing), and the hero
     exit, the service cycle and the film each measure scroll against a
     different span, so ?p= cannot stand in for it: forcing one number into
     three different clocks would photograph a moment that never happens.
     Feeding all three off one virtual scroll position is the only way a
     capture can prove the relative timing, which is the whole thing being
     tuned here. Everything reads scrollPos() rather than win.scrollY. */
  var FORCE_SY = qs.has("sy") ? Math.max(0, parseFloat(qs.get("sy")) || 0) : null;
  function scrollPos() {
    return FORCE_SY !== null ? FORCE_SY * win.innerHeight : win.scrollY;
  }

  /* ---------------------------------------------------------------- state */
  var conf = FILM;
  var filmOn = false, videoReady = false, started = false, readyFired = false;
  var target = 0, shown = 0, rafId = null, lastTick = 0;
  var seekBusy = false, pendingTime = null;
  var lastLum = -1, lastFade = -1, lastStageTxt = "", lastBar = -1, lastStageIdx = -1;
  var jankMax = 0, jankAt = 0;
  var introRunning = false, introDone = false, introRaf = null, introBase = 0, introT0 = 0;

  /* The film is the page background now, so it no longer scrubs against the hero's own height.
     It scrubs from the top of the document to the changeover, which is where it hands over to the
     orbit loop. That is the whole point of the move: the build runs behind the hero and the first
     sections rather than behind one screen. */
  /* The film finishes near the foot of the page, not at a marker partway down it. The point of it
     is that the house goes up as you scroll, so the build should still have somewhere to go when
     you are most of the way through. There is no changeover to stop at any more: the orbit loop
     is gone and this is the only background there is. */
  function scrubEnd() {
    var docH = Math.max(doc.documentElement.scrollHeight, win.innerHeight + 1);
    return Math.max(1, docH - win.innerHeight * 1.7);
  }
  /* Eased, not linear. Linear meant a quarter of the page spent a quarter of the build, and the
     complaint was that the house was going up too fast to watch. Raising the input to a power
     holds the early part back: a quarter of the way down now spends about a ninth of the film, so
     the dig and the foundation take real scrolling, and the later stages, which read faster
     anyway because more is changing per frame, catch up. It still finishes exactly at the
     changeover, so nothing is lost, it is just distributed the way the eye wants it. */
  var SCRUB_EASE = 1.7;
  function progress() {
    if (FORCE_P !== null) return FORCE_P;
    var raw = clamp(scrollPos() / scrubEnd(), 0, 1);
    return introBase + (1 - introBase) * Math.pow(raw, SCRUB_EASE);
  }

  /* The captions run off raw scroll, not off the film's position. The two used to be the same
     number, which meant the opening run faded the hero copy and buttons out while nobody had
     touched anything. Nothing in the hero should move on its own: the film may start itself, the
     words wait to be scrolled. */
  function beatProgress() {
    if (FORCE_P !== null) return FORCE_P;
    return clamp(scrollPos() / scrubEnd(), 0, 1);
  }

  /* The service cycle's own clock: screens of scroll, not film position. */
  function svcProgress() {
    if (FORCE_P !== null) return FORCE_P;
    return clamp(scrollPos() / Math.max(1, win.innerHeight * SVC_SPAN), 0, 1);
  }

  /* 0 through the hero and 1 by the time the first content section is properly in view. veil.css
     consumes it. Published on the layer rather than the root so it cannot collide with anything
     else, and written at two decimals because more just churns style recalculation. */
  /* The film state classes have to land on the background layer as well as the hero. The CSS that
     reveals the video is written as ".film.live .film-video", and the video is no longer inside
     .film, so after the move it stayed at opacity 0 for ever and only the still poster ever
     showed. That is why the background looked like a photograph rather than a film. */
  function filmClass(name, on) {
    if (film) film.classList.toggle(name, !!on);
    if (envLayer) envLayer.classList.toggle(name, !!on);
  }

  /* The hero leaves on scroll, not on film position. 0 at the top, 1 by two thirds of a screen
     down, which is short on purpose: the client's note was that scrolling did not feel like it
     was doing anything. The crest and the caption block both ride this, so the first flick of the
     wheel visibly moves the page even though the film underneath is barely advancing. */
  var lastHeroOut = -1;
  function updateHeroExit() {
    if (!stage) return;
    var t = rmq.matches ? 0 : clamp(scrollPos() / (win.innerHeight * 0.66), 0, 1);
    if (Math.abs(t - lastHeroOut) < 0.004) return;
    lastHeroOut = t;
    /* published on the root, not the stage, because the film scrim lives in the background layer
       and has to read the same number */
    root.style.setProperty("--heroOut", t.toFixed(3));
  }

  var lastVeil = -1;
  function updateVeil() {
    if (!envLayer) return;
    var vh = win.innerHeight;
    /* rmq, not reduced(). reduced() is also true in ?still=1 capture mode, and forcing the veil
       to full there would make every screenshot of this site darker than the site. */
    var v = rmq.matches ? 1 : clamp((win.scrollY - vh * 0.45) / (vh * 0.75), 0, 1);
    if (Math.abs(v - lastVeil) < 0.01) return;
    lastVeil = v;
    envLayer.style.setProperty("--veil", v.toFixed(2));
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
      filmClass("loaded", true);
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
          filmClass("live", true);
          win.setTimeout(markReady, 120);
        }, { once: true });
        requestSeek(p * video.duration);
        win.setTimeout(function () { filmClass("live", true); markReady(); }, 2500);
      } else {
        requestSeek(p * video.duration);
        win.setTimeout(function () {
          filmClass("live", true);
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

  /* Called with no argument: it reads both clocks itself, so no call site has
     to remember that there are two. */
  function updateBeats() {
    paintBeats(svcBeats, svcProgress());
    paintBeats(filmBeats, beatProgress());
  }

  function paintBeats(list, p) {
    for (var i = 0; i < list.length; i++) {
      var b = list[i], raw = clamp(beatAlpha(b, p), 0, 1);
      var e = raw * raw * (3 - 2 * raw);
      if (Math.abs(e - b.op) < 0.008) continue;
      var rising = p < b.peak;
      b.op = e;
      b.el.style.opacity = e.toFixed(3);
      b.el.style.transform = "translate3d(0," + ((1 - e) * (rising ? 16 : -12)).toFixed(1) + "px,0)";
      b.el.style.visibility = e > 0.004 ? "visible" : "hidden";
      b.el.style.pointerEvents = e > 0.6 ? "auto" : "none";
      /* The accent rule under a service line draws itself once the line is
         mostly there and retracts on the way out. It is a flag, not a
         fraction, on purpose: CSS owns the half second it takes to draw, so
         the rule sweeps at a constant speed no matter how fast the page is
         being scrolled, while the line itself stays tied to the scroll. The
         one thing that must not happen is writing this every frame, hence the
         stored last value: it is a variable a transition depends on, and
         rewriting it mid-transition restarts the sweep. */
      if (b.rule) {
        var drawn = e > 0.55 ? 1 : 0;
        if (drawn !== b.drawn) {
          b.drawn = drawn;
          b.el.style.setProperty("--beatOn", drawn);
        }
      }
    }
  }

  function updateFilmChrome(p) {
    var f = clamp((p - 0.945) / 0.055, 0, 1);
    applyChromeTone(p, f);
    if (Math.abs(f - lastFade) > 0.008) {
      lastFade = f;
      if (fadeEl) fadeEl.style.opacity = f.toFixed(3);
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
    /* deliberately not updateBeats here. The opening run moves the film, not the words. */
    updateFilmChrome(p);
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
      introBase = dur ? clamp(video.currentTime / dur, 0, 0.94) : 0;
      /* The hero's scroll range exists only to scrub the film, and the intro has just spent part
         of it. Shrink the range by the same fraction, so whatever film is left scrubs at the
         speed it always did rather than being squeezed into the full eleven screens. Play the
         whole thing through and this leaves about a screen and a half, which is what carries the
         fade into the page. Bail at a tenth and it keeps nine tenths of the distance.
         Safe here because it only ever shortens the page below a visitor who has not scrolled
         yet, so nothing moves under them. */
      if (filmScroll && !STILL && FORCE_P === null) {
      }
      seekBusy = false; pendingTime = null;
      var p = progress();
      shown = target = p;
      updateBeats(); updateFilmChrome(p);
      filmClass("intro", false);
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
    filmClass("intro", true);
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
        filmClass("intro", false);
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
    win.setTimeout(function () { if (introRunning) endIntro("timeout"); }, 26000);
  }

  /* ---------------------------------------------------------------- modes */
  function goStatic() {
    if (introRunning) endIntro("bail");
    filmOn = false;
    if (!film) { markReady(); return; }
    filmClass("static", true);
    filmClass("live", false);
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
    filmClass("static", false);
    if (filmScroll) filmScroll.style.height = "";
    if (stage) stage.style.height = "";
    filmOn = true;
    var p = progress();
    shown = target = p;
    updateBeats(); updateFilmChrome(p);
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
      updateBeats();
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
    updateVeil();
    updateHeroExit();
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
      /* 4:3, not 16:9. These are the client's own photographs and most of them are portrait at
         382 by 510, so a wide frame both crops them to a letterbox slot and stretches them. The
         stage is also capped in CSS: at full page width a 382px picture was being drawn three
         times its own size, which is what made it look soft. */
      /* measure the stage the canvas actually sits in, not the whole component. On a wide screen
         the component is a two column grid and the stage is one of the columns, so measuring the
         component gave a height for a width the canvas never had. */
      var host = $(".builder-stage", wrap) || wrap;
      var w = host.clientWidth || wrap.clientWidth, h = Math.round(w * 3 / 4);
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
          /* checked again here, not only when the observer was made. Somebody can turn reduced
             motion on between the page loading and this section coming into view, and the site
             honours that switch live everywhere else. */
          if (reduced()) { bt = btarget = 0; bpaint(0, true); return; }
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

    /* The chips keep a comma list at the head of the message, so whatever the visitor picks is
       already written for them and they can still edit it by hand. */
    var otherChip = $('[data-job="Other"]', form);
    var otherField = $("#other-field");
    var otherInput = $("#f-other");
    var otherLast = "";           /* what this field last contributed, so it can be swapped out */

    function msgParts() {
      if (!msg) return [];
      return msg.value.split(/,\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    /* Replace one entry with another in place, rather than removing and appending, so editing the
       free-text box does not keep shunting it to the end of the list while somebody is typing. */
    function swapPart(oldV, newV) {
      if (!msg) return;
      var parts = msgParts();
      var i = oldV ? parts.indexOf(oldV) : -1;
      if (i > -1) {
        if (newV) parts[i] = newV; else parts.splice(i, 1);
      } else if (newV && parts.indexOf(newV) === -1) {
        parts.push(newV);
      }
      msg.value = parts.join(", ");
    }

    $$("[data-job]").forEach(function (chip) {
      if (chip === otherChip) return;   /* wired below, it has a field to open */
      on(chip, "click", function () {
        if (!msg) return;
        var v = chip.dataset.job;
        var pressed = chip.getAttribute("aria-pressed") === "true";
        chip.setAttribute("aria-pressed", pressed ? "false" : "true");
        swapPart(pressed ? v : null, pressed ? null : v);
      });
    });

    function setOther(on_) {
      if (!otherChip || !otherField) return;
      otherChip.setAttribute("aria-pressed", on_ ? "true" : "false");
      otherChip.setAttribute("aria-expanded", on_ ? "true" : "false");
      otherField.hidden = !on_;
      if (on_) {
        if (otherInput) otherInput.focus();
      } else {
        swapPart(otherLast, null);
        otherLast = "";
        if (otherInput) { otherInput.value = ""; showError(otherInput, false); }
      }
    }
    on(otherChip, "click", function () {
      setOther(otherChip.getAttribute("aria-pressed") !== "true");
    });
    on(otherInput, "input", function () {
      var v = otherInput.value.trim();
      swapPart(otherLast, v);
      otherLast = v;
    });

    function showError(input, show) {
      var m = $('.err[data-for="' + input.id + '"]', form);
      if (m) m.hidden = !show;
      if (show) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    }
    function validate() {
      var okAll = true, first = null;
      var ids = ["f-name", "f-contact", "f-postal", "f-msg"];
      /* only required while it is on screen, because a hidden field nobody can see must never be
         the reason a form refuses to send */
      if (otherField && !otherField.hidden) ids.push("f-other");
      ids.forEach(function (id) {
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
      otherLast = "";
      if (otherChip) otherChip.setAttribute("aria-expanded", "false");
      if (otherField) otherField.hidden = true;
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
      updateBeats(); updateFilmChrome(FORCE_P);
    }
    if (reduced()) markReady();
    win.setTimeout(markReady, 8000);
  }

  if (doc.readyState === "loading") on(doc, "DOMContentLoaded", boot);
  else boot();
})();
