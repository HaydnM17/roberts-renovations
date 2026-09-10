/* Roberts Renovations, motion layer: pointer parallax + scrubbed section entrances.
   Owned by agent K. Plain ES5, no dependencies, no build step, no libraries.
   Reads index.html, styles.css, extras.css and script.js but never writes to them, and never
   touches anything inside .film-stage. Everything here is decoration: the page must be complete
   and correct with this file absent, and motion.css alone (this file missing) must also render
   a normal, static page since every custom property it consumes has a resting-state fallback. */
(function () {
  "use strict";
  var doc = document, win = window, root = doc.documentElement;

  var rmq = matchMedia("(prefers-reduced-motion: reduce)");
  var pmq = matchMedia("(hover: hover) and (pointer: fine)");

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var on = function (el, ev, fn, o) { if (el) el.addEventListener(ev, fn, o); };
  var off = function (el, ev, fn, o) { if (el) el.removeEventListener(ev, fn, o); };

  /* Checked live, at the moment of every frame and every event, never cached at startup. The
     site flips body.rm the instant the OS setting changes (script.js's own rmq "change"
     handler), and folds ?still=1 into that same class during its boot(), which runs before this
     file's boot() because script.js is loaded first and both scripts are deferred, so deferred
     scripts run in document order. Either way this function re-checks both signals every time,
     so it is correct even if that ordering ever changes. */
  function reduced() {
    return rmq.matches || (doc.body && doc.body.classList.contains("rm"));
  }

  function smoothstep(x) {
    x = clamp(x, 0, 1);
    return x * x * (3 - 2 * x);
  }

  /* ---------------------------------------------------------------- pointer parallax
     --mx and --my live on the root element, roughly -0.5..0.5, and are the only thing this half
     of the file writes. Publishing the eased value rather than the raw pointer position is what
     makes the drift trail the cursor instead of snapping to it. */
  var mxT = 0, myT = 0, mxS = 0, myS = 0;
  var pRaf = null, pzLive = false;
  var LERP = 0.12;
  var REST_EPS = 0.0004;

  function setPzLive(v) {
    if (v === pzLive) return;
    pzLive = v;
    root.classList.toggle("mo-pz", v);
  }

  function writeMxMy(x, y) {
    root.style.setProperty("--mx", x.toFixed(4));
    root.style.setProperty("--my", y.toFixed(4));
  }

  /* One lerp step: reads mxT/myT and mxS/myS, writes --mx/--my, returns where it landed. Kept as
     a plain callable (not buried inside the rAF callback) so a headless harness can drive it by
     hand, once per call, with no rAF: rAF callbacks never fire under --virtual-time-budget, so
     the only way to prove this maths in a capture is to call the step function directly and read
     the property back. */
  function stepPointer() {
    if (reduced()) {
      mxT = myT = mxS = myS = 0;
      writeMxMy(0, 0);
      setPzLive(false);
      return { mx: 0, my: 0, resting: true };
    }
    mxS += (mxT - mxS) * LERP;
    myS += (myT - myS) * LERP;
    if (Math.abs(mxT - mxS) < REST_EPS) mxS = mxT;
    if (Math.abs(myT - myS) < REST_EPS) myS = myT;
    writeMxMy(mxS, myS);
    var resting = mxS === mxT && myS === myT;
    setPzLive(!resting);
    return { mx: mxS, my: myS, resting: resting };
  }

  function pointerFrame() {
    var r = stepPointer();
    if (r.resting) { pRaf = null; return; }
    pRaf = requestAnimationFrame(pointerFrame);
  }

  function onPointerMove(e) {
    if (reduced()) return;
    mxT = clamp(e.clientX / win.innerWidth - 0.5, -0.5, 0.5);
    myT = clamp(e.clientY / win.innerHeight - 0.5, -0.5, 0.5);
    if (pRaf === null) pRaf = requestAnimationFrame(pointerFrame);
  }

  /* Parallax is meaningless on a touch screen, so the listener is never attached at all when the
     device has no fine hover pointer, not merely ignored once attached. Re-checked on both
     matchMedia queries changing live (a mouse plugged into a tablet, the OS reduced-motion
     toggle), never just once at startup. */
  var pointerWired = false;
  function setPointerGate() {
    var want = pmq.matches && !reduced();
    if (want === pointerWired) return;
    pointerWired = want;
    if (want) {
      on(win, "pointermove", onPointerMove, { passive: true });
    } else {
      off(win, "pointermove", onPointerMove);
      mxT = myT = mxS = myS = 0;
      writeMxMy(0, 0);
      setPzLive(false);
      if (pRaf !== null) { cancelAnimationFrame(pRaf); pRaf = null; }
    }
  }
  on(pmq, "change", setPointerGate);

  /* ---------------------------------------------------------------- section entrances
     A smoothstep envelope per .section: an "enter" term rising 0..1 as the section climbs up
     from below the fold, and an "exit" term that only ever pulls the envelope down to a floor
     (never back to 0) once the section starts leaving over the top. Combined (enter * exitTerm)
     they give the brief's shape: rises and settles on the way in, recedes slightly on the way
     out, and can never exceed its resting size, because every mapped value below only ever moves
     away from the resting state (y away from 0, scale down from 1, opacity down from 1). */
  var ENTER_SPAN = 0.55;   /* fraction of viewport height the enter ramp plays out over */
  var EXIT_SPAN = 0.3;     /* fraction of viewport height the exit ramp plays out over */
  var EXIT_FLOOR = 0.85;   /* envelope never recedes past this on the way out: "slightly" */
  var Y_PX = 24, SCALE_AMT = 0.04, OP_FLOOR = 0.55;
  var NEAR_MARGIN = 0.4;   /* fraction of viewport height either side still worth computing */
  var REST_E = 0.997;      /* envelope this close to 1 is treated as fully landed */

  function envelope(top, bottom, vh) {
    var enter = smoothstep((vh - top) / (vh * ENTER_SPAN));
    var exitT = smoothstep(bottom / (vh * EXIT_SPAN));
    var exitTerm = EXIT_FLOOR + (1 - EXIT_FLOOR) * exitT;
    return enter * exitTerm;
  }

  function valuesFor(e) {
    return {
      y: (1 - e) * Y_PX,
      s: 1 - (1 - e) * SCALE_AMT,
      o: OP_FLOOR + e * (1 - OP_FLOOR)
    };
  }

  var motionSections = [];
  var scrollRaf = null;

  function landSection(el) {
    if (!el.classList.contains("mo-scrub")) return;
    el.classList.remove("mo-scrub");
    el.style.removeProperty("--sec-y");
    el.style.removeProperty("--sec-s");
    el.style.removeProperty("--sec-o");
  }

  function applySection(el, e) {
    var v = valuesFor(e);
    el.classList.add("mo-scrub");
    el.style.setProperty("--sec-y", v.y.toFixed(2) + "px");
    el.style.setProperty("--sec-s", v.s.toFixed(4));
    el.style.setProperty("--sec-o", v.o.toFixed(3));
    return v;
  }

  function landAllSections() {
    for (var i = 0; i < motionSections.length; i++) landSection(motionSections[i]);
    if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
  }

  /* Read every section's rect first, then write every section's properties: two passes, never
     interleaved, so no write in this function can force a layout read for the next one. */
  function scrollFrame() {
    scrollRaf = null;
    if (reduced()) { landAllSections(); return; }
    var vh = win.innerHeight, margin = vh * NEAR_MARGIN;
    var reads = [], i, el, r;
    for (i = 0; i < motionSections.length; i++) {
      el = motionSections[i];
      r = el.getBoundingClientRect();
      reads.push({ el: el, top: r.top, bottom: r.bottom });
    }
    for (i = 0; i < reads.length; i++) {
      var it = reads[i];
      if (it.bottom < -margin || it.top > vh + margin) { landSection(it.el); continue; }
      var e = envelope(it.top, it.bottom, vh);
      if (e > REST_E) { landSection(it.el); continue; }
      applySection(it.el, e);
    }
  }

  function onScroll() {
    if (reduced()) { landAllSections(); return; }
    if (scrollRaf === null) scrollRaf = requestAnimationFrame(scrollFrame);
  }

  var resizeT = null;
  function onResize() {
    win.clearTimeout(resizeT);
    resizeT = win.setTimeout(onScroll, 160);
  }

  /* ---------------------------------------------------------------- reduced motion, live */
  function applyReducedNow() {
    setPointerGate();
    if (reduced()) landAllSections(); else onScroll();
  }
  on(rmq, "change", applyReducedNow);

  /* ---------------------------------------------------------------- debug surface
     window.__motion exposes the pure maths so a headless harness can call it directly with made
     up numbers and check the return values against a hand calculation: rAF never runs and
     scrolling does nothing under --virtual-time-budget, so watching the page is not a way to
     prove this file's arithmetic, only calling it is. */
  win.__motion = {
    smoothstep: smoothstep,
    envelope: envelope,
    valuesFor: valuesFor,
    get mx() { return mxS; },
    get my() { return myS; },
    get pzLive() { return pzLive; },
    get reducedNow() { return reduced(); },
    setPointerTarget: function (mx, my) {
      mxT = clamp(mx, -0.5, 0.5);
      myT = clamp(my, -0.5, 0.5);
    },
    stepPointer: stepPointer,
    sectionCount: function () { return motionSections.length; },
    computeSection: function (i) {
      var el = motionSections[i];
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var vh = win.innerHeight;
      var e = envelope(r.top, r.bottom, vh);
      return { top: r.top, bottom: r.bottom, vh: vh, e: e, v: valuesFor(e), landed: el.classList.contains("mo-scrub") === false };
    },
    forceScrollFrame: function () { scrollFrame(); },
    forceLand: function () { landAllSections(); }
  };

  /* ---------------------------------------------------------------- boot */
  function boot() {
    motionSections = $$(".section");
    root.style.setProperty("--mx", "0.0000");
    root.style.setProperty("--my", "0.0000");
    setPointerGate();
    on(win, "scroll", onScroll, { passive: true });
    on(win, "resize", onResize);
    if (reduced()) landAllSections(); else onScroll();
  }

  if (doc.readyState === "loading") on(doc, "DOMContentLoaded", boot);
  else boot();
})();
