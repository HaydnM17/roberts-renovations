/* ------------------------------------------------------------------------
   carousel.js

   Turns the static #services <ul class="svc-tiles"> grid (six <li><a><img>
   <span></a></li> tiles) into a self-driving depth-drift carousel, built
   entirely at runtime the way reviews-slider.js in this same folder builds
   the reviews carousel: read the existing tiles, clone the set twice,
   rebuild the section in place. index.html is never touched, and if this
   file fails to load or fails to run, .svc-tiles is left exactly as
   styles.css already draws it: a plain grid of six tiles.

   Mechanism is the depth-drift-carousel skill, kept close to its reference
   demo (C:\Users\haydn\.claude\skills\depth-drift-carousel\demo\index.html,
   itself extracted from D:\haydn\Website-v2\script.js around [data-strip]):
   one float position drives everything, written to view.scrollLeft every
   frame; three cloned sets so the wrap always has a whole set laid out on
   both sides of the live position; every cell repaints its own scale,
   opacity and transform-origin as a pure function of its distance from the
   view's own centre; a held-reasons object gates the rAF loop. This site is
   a single page, not the reference's two-page SPA, so the fifth "other page"
   pause reason and its hook are dropped -- see docs/AGENT-CAROUSEL-LOG.md.

   Debug hook: window.__car = { originalCount, cellCount, setWidth(), pos(),
   scrollLeft(), running(), nearestIndex(), step(dir), cellCenter(i) }. See
   docs/AGENT-CAROUSEL-LOG.md for how it was driven and read back through a
   --dump-dom capture.
   ------------------------------------------------------------------------ */

(function () {
  "use strict";

  /* Checked fresh every time, never cached: script.js flips body.rm live on
     a prefers-reduced-motion change (and once at load under ?still=1
     capture mode), and this has to see that the moment it acts, not the
     value that happened to be true when the carousel booted. */
  function reduced() {
    var mql = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var mqlReduced = !!(mql && mql.matches);
    var bodyReduced = !!(document.body && document.body.classList.contains("rm"));
    return mqlReduced || bodyReduced;
  }

  function init() {
    var section = document.getElementById("services");
    if (!section) return;
    var host = section.querySelector("ul.svc-tiles");
    if (!host) return;

    var originals = [];
    var kids = host.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeName === "LI") originals.push(kids[i]);
    }
    /* Fewer than two tiles: nothing to drift between. Leave the grid alone. */
    if (originals.length < 2) return;

    build(host, originals);
  }

  function build(host, originals) {
    var originalCount = originals.length;

    /* ---------------------------------------------------------- markup
       strip (wrap) > view > track(host) + prev/next buttons, matching the
       skill's wiring order. host is the existing <ul class="svc-tiles">
       itself, given a second class rather than replaced, exactly like
       reviews-slider.js adds "rev-track" onto the existing <ul class="reviews">
       instead of building a new list. That is what keeps the plain-grid
       fallback true with this script absent: .svc-tiles alone still carries
       styles.css's grid rules, and carousel.css only styles the compound
       ".svc-tiles.car-track" selector this script is about to add. */
    var strip = document.createElement("div");
    strip.className = "svc-carousel";

    var view = document.createElement("div");
    view.className = "car-view";
    view.setAttribute("tabindex", "0");
    view.setAttribute("role", "group");
    view.setAttribute("aria-label", "Services, scrolls sideways");

    var parent = host.parentNode;
    parent.insertBefore(strip, host);
    strip.appendChild(view);
    view.appendChild(host);
    host.classList.add("car-track");

    originals.forEach(function (cell) { cell.classList.add("car-cell"); });

    /* Three sets total (original + two clones) so the live position always
       has a whole set of tiles laid out on both sides of it. Two sets left
       a gap on the left the instant the position wrapped back to the start,
       because nothing existed before the first tile. Clones are hidden from
       both the accessibility tree and the tab order on the <li> and on the
       link inside it, since the link is the real tab stop. */
    for (var copies = 0; copies < 2; copies++) {
      originals.forEach(function (cell) {
        var copy = cell.cloneNode(true);
        copy.setAttribute("aria-hidden", "true");
        var copyLink = copy.querySelector("a");
        if (copyLink) copyLink.setAttribute("tabindex", "-1");
        host.appendChild(copy);
      });
    }

    var cells = Array.prototype.slice.call(host.children);

    var prev = document.createElement("button");
    prev.type = "button";
    prev.className = "car-btn car-prev";
    prev.setAttribute("aria-label", "Previous service");
    prev.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var next = document.createElement("button");
    next.type = "button";
    next.className = "car-btn car-next";
    next.setAttribute("aria-label", "Next service");
    next.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    strip.appendChild(prev);
    strip.appendChild(next);

    /* ---------------------------------------------------------- geometry */
    var setWidth = 0;
    function measure() {
      /* distance from the first tile to its own clone: one whole set. Cell
         width is a plain length in carousel.css (min()/vw), never a
         container-query unit with no query-container ancestor: that leaves
         the whole flex:0 0 var(--cw) declaration invalid and the browser
         falls back to the <img>'s natural pixel width, which is what
         collapsed the entire row across the page on the reference site. */
      setWidth = cells[originalCount].offsetLeft - cells[0].offsetLeft;
    }

    /* The drift keeps its own float position because writing a fractional
       increment straight to scrollLeft gets rounded away below about a
       pixel a frame, and 40px/s at 60fps is 0.66px/frame: under that
       threshold the browser's integer rounding eats the whole movement and
       the strip looks completely frozen even though this loop is running.
       Reset to null whenever something else moves the strip (a step, a
       resize) so the next frame re-reads the live value instead of writing
       a stale one back. */
    var pos = null;
    var DRIFT = 40; /* px/s, kept from the skill: about ten seconds a tile */

    function wrap() {
      if (setWidth <= 0) return;
      if (pos === null) pos = view.scrollLeft;
      if (pos >= setWidth * 2) pos -= setWidth;
      else if (pos < setWidth) pos += setWidth;
      view.scrollLeft = pos;
    }

    /* Run before first paint so the strip opens with tiles on both sides
       of the middle set, not flush against the first tile with nothing to
       its left until it is interacted with. */
    function normalise() {
      if (setWidth <= 0) return;
      var p = pos === null ? view.scrollLeft : pos;
      pos = setWidth + (((p % setWidth) + setWidth) % setWidth);
      view.scrollLeft = pos;
    }

    function paint() {
      if (reduced()) return;
      var mid = view.scrollLeft + view.clientWidth / 2;
      var span = view.clientWidth;
      if (!span) return;
      cells.forEach(function (cell) {
        var off = cell.offsetLeft + cell.offsetWidth / 2 - mid;
        var d = Math.abs(off) / span;
        var scale = Math.max(0.84, 1 - d * 0.38);
        var fade = Math.max(0.38, 1 - d * 1.5);
        /* transform-origin slides across the cell with the same distance
           value used for the scale, rather than sitting fixed at 50% 50%.
           A fixed origin shrinks every cell toward its own middle, which
           visibly drags off-centre cells sideways from where the eye
           expects them; a sliding origin keeps the motion continuous. */
        var t = Math.max(-1, Math.min(1, off / (span * 0.5)));
        cell.style.transformOrigin = (50 - t * 50).toFixed(1) + "% 50%";
        cell.style.transform = "scale(" + scale.toFixed(3) + ")";
        cell.style.opacity = fade.toFixed(3);
        cell.classList.toggle("is-focus", d < 0.14);
      });
    }

    /* Reasons the drift is currently stopped. Four independent reasons, the
       full portable set per the skill once the reference site's fifth
       "other SPA page" reason is dropped, plus "step" which coordinates
       with an in-flight arrow/click scroll rather than being an external
       pause cause. A single boolean could not represent "should be paused
       for reason A but reason B just cleared" without one reason's clear
       accidentally resuming it, so each reason is tracked independently and
       running is recomputed from all of them together. */
    var held = { hover: false, press: false, hidden: document.hidden, off: true, step: false };
    var running = false, last = 0, raf = 0;

    function frame(now) {
      if (!running) return;
      var dt = Math.min((now - last) / 1000, 0.05); /* clamp after a stall */
      last = now;
      if (pos === null) pos = view.scrollLeft;
      pos += DRIFT * dt;
      wrap();
      paint();
      raf = window.requestAnimationFrame(frame);
    }

    function sync() {
      var should = !reduced() && !held.hover && !held.press && !held.hidden && !held.off && !held.step;
      strip.setAttribute("data-running", should ? "true" : "false");
      if (should === running) return;
      running = should;
      if (running) {
        last = window.performance.now();
        pos = null; /* something may have moved the strip while stopped */
        raf = window.requestAnimationFrame(frame);
      } else {
        window.cancelAnimationFrame(raf);
      }
    }
    function hold(key, on) { held[key] = on; sync(); }

    function nearestIndex() {
      var mid = view.scrollLeft + view.clientWidth / 2;
      var best = 0, dist = Infinity;
      cells.forEach(function (cell, i) {
        var d = Math.abs(cell.offsetLeft + cell.offsetWidth / 2 - mid);
        if (d < dist) { dist = d; best = i; }
      });
      return best;
    }

    /* Arrows, keys and a click all step through this one function and hand
       back to the drift once the browser's own smooth scroll has landed --
       one implementation, three triggers. */
    var stepTimer = 0;
    function goTo(target) {
      if (!target) return;
      hold("step", true);
      view.scrollTo({
        left: target.offsetLeft + target.offsetWidth / 2 - view.clientWidth / 2,
        behavior: reduced() ? "auto" : "smooth"
      });
      window.clearTimeout(stepTimer);
      stepTimer = window.setTimeout(function () {
        /* the scroll moved the strip, so the drift's cached position is
           stale: re-read before wrapping, or the wrap writes the old value
           straight back and the strip visibly jumps backward a moment
           after the arrow click that just snapped it forward. */
        pos = null;
        wrap();
        hold("step", false);
      }, 700);
    }
    function step(dir) {
      var targetIndex = Math.min(cells.length - 1, Math.max(0, nearestIndex() + dir));
      goTo(cells[targetIndex]);
      return targetIndex;
    }
    prev.addEventListener("click", function () { step(-1); });
    next.addEventListener("click", function () { step(1); });
    view.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
      if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
    });

    /* Clicking a tile centres it first, the same path the arrows use, so a
       dim tile at the edge is a target rather than something walked to with
       the arrows first. Every tile links to the same #work anchor, so there
       is no separate detail view to open the way the reference site opens a
       lightbox: default navigation is left alone and simply follows once
       the click has been handled, rather than being held back for an
       animation with nothing to reveal at the end of it. */
    host.addEventListener("click", function (e) {
      var cell = e.target.closest ? e.target.closest(".car-cell") : null;
      if (!cell) return;
      goTo(cell);
    });

    view.addEventListener("scroll", paint, { passive: true });
    strip.addEventListener("pointerenter", function () { hold("hover", true); });
    strip.addEventListener("pointerleave", function () { hold("hover", false); });
    strip.addEventListener("focusin", function () { hold("hover", true); });
    strip.addEventListener("focusout", function () { hold("hover", false); });
    view.addEventListener("pointerdown", function () { hold("press", true); });
    window.addEventListener("pointerup", function () { hold("press", false); }, { passive: true });
    document.addEventListener("visibilitychange", function () { hold("hidden", document.hidden); });

    var motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

    /* Reduced motion does not hide the carousel: it becomes a plain native
       horizontal scroller with the prev/next buttons still working. Every
       inline style paint() wrote is stripped and every cell gets the
       focused look, so nothing is left looking artificially dimmed or
       shrunk from the last frame painted before motion was reduced. */
    function settle() {
      measure();
      normalise();
      if (reduced()) {
        cells.forEach(function (cell) {
          cell.style.transform = "";
          cell.style.opacity = "";
          cell.style.transformOrigin = "";
          cell.classList.add("is-focus");
        });
      } else {
        paint();
      }
      sync();
    }

    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(settle, 120);
    }, { passive: true });
    if (motionQuery && typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", settle);
    }

    if ("IntersectionObserver" in window) {
      new window.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { hold("off", !entry.isIntersecting); });
      }, { threshold: 0.15 }).observe(strip);
    } else {
      held.off = false;
    }

    /* Images arrive late and the set width depends on them. */
    window.addEventListener("load", settle);
    settle();

    window.__car = {
      originalCount: originalCount,
      cellCount: cells.length,
      setWidth: function () { return setWidth; },
      pos: function () { return pos; },
      scrollLeft: function () { return view.scrollLeft; },
      running: function () { return running; },
      nearestIndex: nearestIndex,
      step: step,
      cellCenter: function (i) {
        var c = cells[i];
        return c ? c.offsetLeft + c.offsetWidth / 2 : null;
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
