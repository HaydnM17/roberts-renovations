/* ------------------------------------------------------------------------
   reviews-slider.js  (Agent J)

   Turns the static #reviews <ul class="reviews"> grid (ten <li class="review">
   items, each a <blockquote> plus a <footer><b> name </b><span> job </span>)
   into an infinitely looping horizontal carousel, built entirely at runtime.
   index.html itself is never touched: this script reads the existing markup,
   clones it, and rebuilds the section in place.

   Load order matters: this file must run BEFORE script.js (both as plain
   <script defer> tags, in that order, in <head>) so that script.js's own
   wireSpotlight() -- which runs once at its boot() and queries the DOM for
   [data-spot] at that moment -- sees the final, rebuilt set of thirty cards
   rather than the original ten. Getting the order right costs nothing here
   and buys the cursor-follow glow on every clone for free; getting it wrong
   just falls back to the CSS default centred glow on hover, which is still
   fine, never broken.

   Debug hook: window.__rev = { activeIndex, cardCount, originalCount, shift,
   classes, goTo(index) }. See docs/AGENT-J-LOG.md for how it was driven and
   read back through a --dump-dom capture.
   ------------------------------------------------------------------------ */

(function () {
  "use strict";

  function isReduced() {
    var mql = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var mqlReduced = !!(mql && mql.matches);
    var bodyReduced = !!(document.body && document.body.classList.contains("rm"));
    return mqlReduced || bodyReduced;
  }

  function init() {
    var section = document.getElementById("reviews");
    if (!section) return;
    var host = section.querySelector("ul.reviews");
    if (!host) return;

    var originals = [];
    var kids = host.children;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.nodeName === "LI" && kid.classList && kid.classList.contains("review")) {
        originals.push(kid);
      }
    }
    /* Fewer than three reviews: leave the page exactly as it was. */
    if (originals.length < 3) return;

    build(host, originals);
  }

  function build(host, originals) {
    var originalCount = originals.length;
    var totalCount = originalCount * 3;
    var activeIndex = originalCount; /* start in the middle set */
    var cardWidth = 0;
    var gap = 0;
    var animating = false;
    var safetyTimer = null;
    var resizeTimer = null;
    var dragState = null;
    var suppressClick = false;
    var activeCardEl = null;
    var DRAG_THRESHOLD = 6;
    var cards = [];

    /* ---------------------------------------------------------- markup */
    var wrap = document.createElement("div");
    wrap.className = "rev-carousel";

    var viewport = document.createElement("div");
    viewport.className = "rev-viewport";

    var parent = host.parentNode;
    parent.insertBefore(wrap, host);
    wrap.appendChild(viewport);
    viewport.appendChild(host);

    host.classList.add("rev-track");
    if (!host.id) host.id = "revTrack";
    /* role="list" is explicit rather than relied-on-by-default because
       styles.css resets ul,ol{list-style:none}, which strips the implicit
       list role in older WebKit/VoiceOver. aria-roledescription is left off
       deliberately: this isn't a full ARIA carousel widget (no live-region
       announcements on move), and layering that roledescription over a
       plain labelled list risks a confusing double announcement instead of
       a more accurate one. */
    host.setAttribute("role", "list");
    host.setAttribute("aria-label", "Customer reviews");

    var frag = document.createDocumentFragment();
    var s, c, idx, clone;
    for (s = 0; s < 3; s++) {
      for (c = 0; c < originalCount; c++) {
        idx = s * originalCount + c;
        clone = originals[c].cloneNode(true);
        clone.setAttribute("data-review-index", String(idx));
        if (s === 1) {
          clone.removeAttribute("aria-hidden");
          clone.setAttribute("tabindex", "0");
        } else {
          clone.setAttribute("aria-hidden", "true");
          clone.setAttribute("tabindex", "-1");
        }
        frag.appendChild(clone);
        cards.push(clone);
      }
    }
    host.innerHTML = "";
    host.appendChild(frag);

    var controls = document.createElement("div");
    controls.className = "rev-controls";

    var prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "rev-btn rev-prev";
    prevBtn.setAttribute("aria-label", "Previous review");
    prevBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var revCount = document.createElement("span");
    revCount.className = "rev-count";
    revCount.setAttribute("aria-hidden", "true");

    var nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "rev-btn rev-next";
    nextBtn.setAttribute("aria-label", "Next review");
    nextBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    controls.appendChild(prevBtn);
    controls.appendChild(revCount);
    controls.appendChild(nextBtn);
    wrap.appendChild(controls);

    /* ---------------------------------------------------------- geometry */
    function measure() {
      var first = cards[0];
      cardWidth = first ? first.getBoundingClientRect().width : 0;
      var cs = window.getComputedStyle(host);
      gap = parseFloat(cs.columnGap) || 0;
    }

    function applyTransform(index) {
      var shift = -((cardWidth + gap) * index);
      host.style.setProperty("--rev-shift", shift + "px");
    }

    function updateActiveState() {
      if (activeCardEl) activeCardEl.removeAttribute("aria-current");
      var card = cards[activeIndex];
      if (card) {
        card.setAttribute("aria-current", "true");
        activeCardEl = card;
      }
      if (revCount) {
        var pos = (activeIndex % originalCount) + 1;
        revCount.textContent = pos + " / " + originalCount;
      }
    }

    /* Instant, un-transitioned reposition: used for the seamless wrap jump,
       for drag-scrub, and to reflect a resize. transition:none is applied
       for two nested rAFs before being lifted, per spec: one frame is not
       enough and the jump becomes visible. */
    function jumpTo(newIndex) {
      activeIndex = newIndex;
      host.classList.add("rev-jump");
      applyTransform(activeIndex);
      updateActiveState();
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          host.classList.remove("rev-jump");
        });
      });
    }

    function normalizeIfNeeded() {
      if (activeIndex >= originalCount * 2) {
        jumpTo(activeIndex - originalCount);
      } else if (activeIndex < originalCount) {
        jumpTo(activeIndex + originalCount);
      }
    }

    function goTo(newIndex, opts) {
      opts = opts || {};
      if (animating && !opts.force) return;
      activeIndex = newIndex;
      applyTransform(activeIndex);
      updateActiveState();
      if (isReduced()) {
        /* No transition will run (and a 0-duration transition never fires
           transitionend), so normalise synchronously instead of waiting. */
        animating = false;
        clearTimeout(safetyTimer);
        normalizeIfNeeded();
        return;
      }
      animating = true;
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(function () {
        if (animating) {
          animating = false;
          normalizeIfNeeded();
        }
      }, 760);
    }

    host.addEventListener("transitionend", function (e) {
      if (e.target !== host || e.propertyName !== "transform") return;
      animating = false;
      clearTimeout(safetyTimer);
      normalizeIfNeeded();
    });

    /* ---------------------------------------------------------- controls */
    prevBtn.addEventListener("click", function () { goTo(activeIndex - 1); });
    nextBtn.addEventListener("click", function () { goTo(activeIndex + 1); });

    /* ---------------------------------------------------------- click a card to centre it */
    host.addEventListener("click", function (e) {
      if (suppressClick) { suppressClick = false; return; }
      var card = e.target.closest ? e.target.closest(".review") : null;
      if (!card || card.parentNode !== host) return;
      var idxAttr = card.getAttribute("data-review-index");
      if (idxAttr === null) return;
      var i2 = parseInt(idxAttr, 10);
      if (i2 === activeIndex) return;
      goTo(i2);
    });

    /* ---------------------------------------------------------- focus must never sit off-screen */
    host.addEventListener("focusin", function (e) {
      var card = e.target.closest ? e.target.closest(".review") : null;
      if (!card || card.parentNode !== host) return;
      var idxAttr = card.getAttribute("data-review-index");
      if (idxAttr === null) return;
      var i2 = parseInt(idxAttr, 10);
      if (i2 === activeIndex) return;
      goTo(i2, { force: true });
    });

    /* Left/right arrow keys step between the ten reachable (tabindex="0")
       cards while one of them has focus. Optional polish, cheap to keep. */
    host.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      var card = e.target.closest ? e.target.closest(".review") : null;
      if (!card || card.getAttribute("tabindex") !== "0") return;
      var i2 = parseInt(card.getAttribute("data-review-index"), 10);
      var dir = e.key === "ArrowLeft" ? -1 : 1;
      var targetIdx = i2 + dir;
      if (targetIdx < originalCount || targetIdx >= originalCount * 2) return;
      var target = cards[targetIdx];
      if (target) {
        e.preventDefault();
        target.focus();
      }
    });

    /* ---------------------------------------------------------- drag / touch scrub */
    viewport.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragState = {
        id: e.pointerId,
        startX: e.clientX,
        startShift: -((cardWidth + gap) * activeIndex),
        moved: false
      };
      host.classList.add("rev-jump");
      if (viewport.setPointerCapture) {
        try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    });

    viewport.addEventListener("pointermove", function (e) {
      if (!dragState || e.pointerId !== dragState.id) return;
      var dx = e.clientX - dragState.startX;
      if (!dragState.moved && Math.abs(dx) > DRAG_THRESHOLD) dragState.moved = true;
      if (!dragState.moved) return;
      host.style.setProperty("--rev-shift", (dragState.startShift + dx) + "px");
    });

    function endDrag(e) {
      if (!dragState || e.pointerId !== dragState.id) return;
      var moved = dragState.moved;
      var dx = e.clientX - dragState.startX;
      var startShift = dragState.startShift;
      host.classList.remove("rev-jump");
      dragState = null;
      if (!moved) return;
      suppressClick = true;
      var finalShift = startShift + dx;
      var nearest = Math.round(-finalShift / (cardWidth + gap));
      goTo(nearest, { force: true });
    }
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);

    /* ---------------------------------------------------------- resize */
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        measure();
        animating = false;
        clearTimeout(safetyTimer);
        jumpTo(activeIndex);
      }, 120);
    });

    /* ---------------------------------------------------------- go */
    measure();
    applyTransform(activeIndex);
    updateActiveState();

    window.__rev = {
      get activeIndex() { return activeIndex; },
      get cardCount() { return totalCount; },
      get originalCount() { return originalCount; },
      get shift() { return -((cardWidth + gap) * activeIndex); },
      get classes() { return host.className; },
      goTo: function (index) { goTo(index, { force: true }); }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
