/* ------------------------------------------------------------------------
   carousel.js

   Turns two static grids into self-driving depth-drift carousels, built
   entirely at runtime the way reviews-slider.js in this same folder builds
   the reviews carousel: read the existing cells, clone the set twice,
   rebuild the section in place. index.html is never touched, and if this
   file fails to load or fails to run, both grids are left exactly as
   site.css already draws them: a plain grid.

   ONE mechanism, TWO callers. build() below takes a small config object
   (host selector, cell tag, class names, aria labels, a clone-neutralising
   callback and an optional filter watcher) and everything else -- drift,
   wrap, depth paint, held-reasons pause gate, keyboard/arrow/click step --
   is shared code with no per-caller branching. The services call and the
   work call differ only in that config, per docs/AGENT-WORKCAR-LOG.md.

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

   The work carousel adds one thing the services one never needed: the
   #work section's filter chips hide and show cells by tag, which changes
   how wide one whole set is. See "filters" below and docs/AGENT-WORKCAR-LOG.md
   for why no rebuild is needed to keep that correct.

   Debug hooks: window.__car (services) and window.__workCar (work), each
   { originalCount, cellCount, setWidth(), pos(), scrollLeft(), running(),
   nearestIndex(), step(dir), cellCenter(i) }, plus __workCar.visibleCount()
   and __workCar.simulateFilter(key) for the filter-aware checks. See
   docs/AGENT-WORKCAR-LOG.md for how these were driven and read back through
   a --dump-dom capture.
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

  /* True for any cell actually taking up space right now, false for one a
     filter (or anything else) has display:none'd. Generic rather than a
     check for one particular class name, so the same test works whether a
     cell is hidden by the work grid's own ".hide" rule or by anything a
     future caller invents. */
  function isVisible(cell) {
    return cell.offsetParent !== null;
  }

  /* The smallest index in [0, originalCount) whose cell is currently
     visible, or -1 if a filter has hidden an entire set. Used instead of
     always trusting index 0, because index 0 itself can be the very cell a
     filter just hid. */
  function firstVisible(cells, originalCount) {
    for (var i = 0; i < originalCount; i++) {
      if (isVisible(cells[i])) return i;
    }
    return -1;
  }

  function init(cfg) {
    var section = document.getElementById(cfg.sectionId);
    if (!section) return;
    var host = section.querySelector(cfg.hostSelector);
    if (!host) return;

    var originals = [];
    var kids = host.children;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeName === cfg.cellTag) originals.push(kids[i]);
    }
    /* Fewer than two cells: nothing to drift between. Leave the grid alone. */
    if (originals.length < 2) return;

    build(host, originals, cfg);
  }

  function build(host, originals, cfg) {
    var originalCount = originals.length;

    /* ---------------------------------------------------------- markup
       strip (wrap) > view > track(host) + prev/next buttons, matching the
       skill's wiring order. host is the existing grid element itself,
       given a second class rather than replaced, exactly like
       reviews-slider.js adds "rev-track" onto the existing <ul class="reviews">
       instead of building a new list. That is what keeps the plain-grid
       fallback true with this script absent: the grid's own class alone
       still carries site.css's grid rules, and the carousel CSS only styles
       the compound "<hostClass>.car-track" selector this script is about to
       add. */
    var strip = document.createElement("div");
    strip.className = cfg.wrapClass;

    var view = document.createElement("div");
    view.className = "car-view";
    view.setAttribute("tabindex", "0");
    view.setAttribute("role", "group");
    view.setAttribute("aria-label", cfg.ariaLabel);

    var parent = host.parentNode;
    parent.insertBefore(strip, host);
    strip.appendChild(view);
    view.appendChild(host);
    host.classList.add("car-track");

    originals.forEach(function (cell) { cell.classList.add("car-cell"); });

    /* Three sets total (original + two clones) so the live position always
       has a whole set of cells laid out on both sides of it. Two sets left
       a gap on the left the instant the position wrapped back to the start,
       because nothing existed before the first cell. Clones are hidden from
       both the accessibility tree and the tab order on the outer element,
       and cfg.neutralizeClone additionally strips whatever makes the inner
       element interactive (a real href for services, the lightbox's
       data-full for work) so a clone can never open a second copy of
       whatever the original opens -- see docs/AGENT-WORKCAR-LOG.md, "the
       lightbox". */
    for (var copies = 0; copies < 2; copies++) {
      originals.forEach(function (cell) {
        var copy = cell.cloneNode(true);
        copy.setAttribute("aria-hidden", "true");
        if (cfg.neutralizeClone) cfg.neutralizeClone(copy);
        host.appendChild(copy);
      });
    }

    var cells = Array.prototype.slice.call(host.children);

    var prev = document.createElement("button");
    prev.type = "button";
    prev.className = "car-btn car-prev";
    prev.setAttribute("aria-label", cfg.prevLabel);
    prev.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var next = document.createElement("button");
    next.type = "button";
    next.className = "car-btn car-next";
    next.setAttribute("aria-label", cfg.nextLabel);
    next.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    /* Inserted BEFORE the view, not appended after it. The buttons are
       absolutely positioned either side of the strip, so their place in the
       DOM has no effect on where they appear, but it decides where they sit
       in the tab order. Appended, a keyboard visitor had to tab through
       every cell in the strip, six service tiles or every visible work
       photo, before reaching the controls that move the strip. That is
       backwards: the arrows are how you drive this thing. */
    strip.insertBefore(prev, view);
    strip.insertBefore(next, view);

    /* ---------------------------------------------------------- geometry */
    var setWidth = 0;
    function measure() {
      /* Distance from one set's first VISIBLE cell to the same relative
         cell in the next set: one whole set, however many cells inside it
         are currently hidden. Plain index 0 was enough for services, which
         never hides a cell, but the work carousel's filter chips can hide
         cell 0 itself (display:none collapses its offsetLeft to 0), which
         would measure a false, degenerate setWidth. Any two cells at the
         same relative position in two different sets carry the same
         hide/show pattern (they are the same source item, cloned), so the
         gap between them is exactly one set width regardless of which
         cells elsewhere in the set are hidden -- see docs/AGENT-WORKCAR-LOG.md,
         "filters".

         Cell width itself is always a plain length in the carousel CSS
         (min()/vw or a computed aspect-ratio), never a container-query unit
         with no query-container ancestor: that would leave the whole
         flex-basis declaration invalid and the browser would fall back to
         each cell's bare pixel size, which is what collapsed the entire row
         across the page on the reference site. */
      var k = firstVisible(cells, originalCount);
      setWidth = k === -1 ? 0 : cells[k + originalCount].offsetLeft - cells[k].offsetLeft;
    }

    /* The drift keeps its own float position because writing a fractional
       increment straight to scrollLeft gets rounded away below about a
       pixel a frame, and 40px/s at 60fps is 0.66px/frame: under that
       threshold the browser's integer rounding eats the whole movement and
       the strip looks completely frozen even though this loop is running.
       Reset to null whenever something else moves the strip (a step, a
       resize, a filter) so the next frame re-reads the live value instead
       of writing a stale one back. */
    var pos = null;
    var DRIFT = cfg.drift || 40; /* px/s, kept from the skill: about ten seconds a cell */

    function wrap() {
      if (setWidth <= 0) return;
      if (pos === null) pos = view.scrollLeft;
      if (pos >= setWidth * 2) pos -= setWidth;
      else if (pos < setWidth) pos += setWidth;
      view.scrollLeft = pos;
    }

    /* Run before first paint so the strip opens with cells on both sides
       of the middle set, not flush against the first cell with nothing to
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

    /* Only a visible cell is a valid "nearest" or step target: a hidden one
       still sits in the DOM (so the wrap arithmetic above can use it as a
       measuring point) but has offsetLeft 0, which would otherwise look
       falsely close to the view's start the moment a filter hides it. */
    function nearestIndex() {
      var mid = view.scrollLeft + view.clientWidth / 2;
      var best = -1, dist = Infinity;
      cells.forEach(function (cell, i) {
        if (!isVisible(cell)) return;
        var d = Math.abs(cell.offsetLeft + cell.offsetWidth / 2 - mid);
        if (d < dist) { dist = d; best = i; }
      });
      return best === -1 ? 0 : best;
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
      /* Walk past hidden cells in the requested direction rather than
         landing on one: a filtered-out cell has no usable offsetLeft, and
         scrolling to it would snap the strip to a nonsense position. */
      var i = nearestIndex() + dir;
      while (i >= 0 && i < cells.length && !isVisible(cells[i])) i += dir;
      i = Math.max(0, Math.min(cells.length - 1, i));
      if (isVisible(cells[i])) goTo(cells[i]);
      return i;
    }
    prev.addEventListener("click", function () { step(-1); });
    next.addEventListener("click", function () { step(1); });
    view.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
      if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
    });

    /* Clicking a cell centres it first, the same path the arrows use, so a
       dim cell at the edge is a target rather than something walked to with
       the arrows first. Nothing here calls preventDefault or stops
       propagation, so whatever the cell's own real content does on click
       (services: the tile's <a> navigates; work: script.js's own listener
       on the un-neutralised original button opens the lightbox) still
       happens exactly as it would without this carousel. */
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

    /* ------------------------------------------------------ filters
       The work grid's filter chips toggle a "hide" class on every figure
       whose tags do not match, via script.js's own generic wireFilters().
       That script queries ".work-grid figure" exactly once, at boot, into a
       plain array of the actual DOM elements that existed then -- which, by
       the time it runs, already includes both clone sets this build() just
       appended, because carousel.js is loaded before script.js precisely so
       its rebuilt markup is what script.js's own boot() sees (see the
       top-of-file banner in reviews-slider.js for the same load-order
       reasoning). So every subsequent filter click toggles "hide" on all
       three sets in lockstep for free, forever, with nothing more required
       from here than reacting to the resulting reflow: no rebuilding or
       re-cloning, which would only orphan script.js's one-time reference to
       these exact elements and silently stop filtering the replacement
       nodes. See docs/AGENT-WORKCAR-LOG.md, "filters", for the full
       reasoning and what was ruled out.

       cfg.watchSelector names the filter bar itself (an ANCESTOR of the
       chip buttons, not the buttons), so this listener runs in the bubble
       phase, after script.js's own listener -- attached directly to each
       button, which fires at the target phase -- has already toggled every
       "hide" class. That ordering is guaranteed by the DOM event flow
       itself, not by which script tag loaded first, so it holds regardless
       of load order. */
    function onFilterChanged() {
      measure();
      if (setWidth <= 0) { sync(); return; }
      /* Jump (not drift) to the first cell the new filter still shows, in
         the middle set, so a filter change lands somewhere deliberate
         instead of wherever the old absolute scrollLeft happens to fall
         once hidden cells around it have collapsed to zero width. */
      var k = firstVisible(cells, originalCount);
      if (k === -1) { sync(); return; }
      var target = cells[originalCount + k];
      pos = target.offsetLeft + target.offsetWidth / 2 - view.clientWidth / 2;
      view.scrollLeft = pos;
      normalise();
      paint();
      sync();
    }
    if (cfg.watchSelector) {
      var watchEl = document.querySelector(cfg.watchSelector);
      if (watchEl) watchEl.addEventListener("click", onFilterChanged);
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

    window[cfg.debugName] = {
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
      },
      visibleCount: function () {
        var n = 0;
        cells.forEach(function (c) { if (isVisible(c)) n++; });
        return n;
      },
      /* Test-only convenience: dispatch a real click on the named filter
         chip so it runs through the exact same path a visitor's click
         would (script.js's toggle, then this file's onFilterChanged via
         bubbling), rather than calling internal functions directly. */
      simulateFilter: cfg.watchSelector ? function (key) {
        var btn = document.querySelector(cfg.watchSelector + ' button[data-filter="' + key + '"]');
        if (btn) btn.click();
        return !!btn;
      } : undefined
    };
  }

  function boot() {
    init({
      sectionId: "services",
      hostSelector: "ul.svc-tiles",
      cellTag: "LI",
      wrapClass: "svc-carousel",
      ariaLabel: "Services, scrolls sideways",
      prevLabel: "Previous service",
      nextLabel: "Next service",
      debugName: "__car",
      /* The clone's real content is a plain <a href="#work">: browser
         navigation on click is not something this script opens, so the
         only thing to strip is its place in the tab order. */
      neutralizeClone: function (copy) {
        var link = copy.querySelector("a");
        if (link) link.setAttribute("tabindex", "-1");
      }
    });

    init({
      sectionId: "work",
      hostSelector: "div.work-grid",
      cellTag: "FIGURE",
      wrapClass: "work-carousel",
      ariaLabel: "Past work, scrolls sideways",
      prevLabel: "Previous project",
      nextLabel: "Next project",
      debugName: "__workCar",
      watchSelector: ".work-filter",
      /* The clone's button carries data-full, which is what script.js's
         wireWorkGrid()/collectShots() key on to wire and count lightbox
         triggers. Left in place, three clones of every photo would each
         open the lightbox and would triple the "x / N" count and the
         prev/next order inside it; if a filter later hid the ORIGINAL that
         opened it, closing the lightbox would try to refocus a node that
         is no longer on screen. Stripping data-full (and data-caption, so
         nothing stale rides along on the node for later) removes the clone
         from both queries entirely, so clicking one only centres it -- the
         same "click walks it to the middle first" behaviour the arrows and
         the true original both already have -- without ever opening a
         second, cloned copy of the viewer. The clone's <figure> keeps its
         data-tags, which is what keeps it hiding and showing in lockstep
         with its original when a filter chip is pressed. */
      neutralizeClone: function (copy) {
        var btn = copy.querySelector("button[data-full]");
        if (btn) {
          btn.removeAttribute("data-full");
          btn.removeAttribute("data-caption");
          btn.setAttribute("tabindex", "-1");
          btn.setAttribute("aria-hidden", "true");
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
