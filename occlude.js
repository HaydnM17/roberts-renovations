/* Roberts Renovations, spec mockup.

   Puts the house in front of the wordmark. The page draws a very large name across the film and
   this redraws the part of the same frame that is not sky back on top of it, so the roofline cuts
   through the letters. On the empty lot at the start there is nothing above the horizon to cut
   anything, and the house takes the name over as it goes up, which is the point of the film.

   Self-contained. No dependency on script.js, no scroll or rAF loop of its own, and nothing here
   ever writes currentTime. The page calls init() once the video has metadata, then update() when
   the frame has actually moved.

   ---- how the matte is built, and why it is not a plain brightness key

   Measured off real frames of this film at 320 wide. In the band the wordmark occupies, the sky
   piles up at 230 to 250 and light grey siding runs 150 to 200. But the white trim boards, the
   gutters and the bright window reflections all push up into the low 230s. A plain brightness key
   set low enough to clear the sky therefore leaves the whole wall semi transparent and the
   letters ghosting through it, and set high enough to keep the wall solid it punches holes
   straight through the trim.

   So the primary test is a silhouette, not a brightness. The house is solid against the sky, so
   for each column we walk down until the sky gives way, and everything below that row is house.
   Trim, glass and gutters all sit below their own column's skyline and survive whatever their
   brightness, which is what keeps the occlusion solid rather than ghosted. A short run is
   required before a skyline is accepted, so one dark speck in the cloud cannot drop it to the top
   of the frame.

   That alone fails in one place: the framing stage, where the wall is a timber skeleton and the
   gaps between the studs are sky sitting below the skyline. Filling those would erase the letters
   with sky-coloured rectangles. So the silhouette is multiplied by a soft brightness term that
   only bites above 232, which is over the trim and under the sky. The gaps clear, the trim holds.
   Checked by rendering this exact arithmetic over frames at 0.2s, 3s, 6.5s, 9.5s, 13s, 16s and
   19.8s and looking at each matte on a contrasting ground.

   Nothing here is load bearing. getImageData throws a SecurityError, permanently, on a canvas
   that has had a file:// video drawn into it, so on a local capture this switches itself off and
   the hero is simply a large name on a film. That is a normal looking hero, which is the point:
   the effect is allowed to be absent. */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- tuning, all measured */
  var SKY_EDGE = 205;   /* under this luma the sky has given way. Sky reads 218+, roof 160 and under */
  var RUN = 3;          /* rows of it required, so noise in the cloud cannot trip the skyline */
  var SOFT_LO = 232;    /* over the trim, under the sky: where the brightness term starts to bite */
  var SOFT_HI = 248;
  var FLOOR = 0.20;     /* sky trapped inside the frame keeps this much, so studs still read solid */
  /* How solid the house is allowed to get over the name. At 1 the finished house erased the
     wordmark completely: the roof peak sits about a tenth of the way down the frame and the wall
     runs to three quarters, so there is no height a word this size can sit at and still straddle
     the roofline. Capping it instead keeps the house plainly in front while the name reads
     through it, all the way from the empty lot to the finished build. */
  var MAX_A = 0.55;
  var CUTOFF = 0.58;    /* keep the top of the frame only, or the lawn is redrawn over itself */
  var FEATHER = 0.12;   /* and ease that lower edge out, so the cap is never a horizontal line */
  var SAMPLE_W = 320;   /* 320 by 180 is 57,600 pixels, which is nothing to walk on a seek */

  var video = null, canvas = null, ctx = null, small = null, sctx = null;
  var armed = false, enabled = true;
  var rowAlpha = null, wash = null;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(k) { return k * k * (3 - 2 * k); }

  /* the vertical falloff depends only on the row, which does not change between paints, so it is
     built once per size rather than recomputed for every pixel on every call */
  function buildRowAlpha(h) {
    rowAlpha = new Float32Array(h);
    var f = FEATHER > 0 ? FEATHER : 1e-4;
    for (var y = 0; y < h; y++) {
      var fr = h > 1 ? y / (h - 1) : 0;
      rowAlpha[y] = smooth(clamp01((CUTOFF + f - fr) / (2 * f)));
    }
  }

  function paint() {
    if (!armed || !enabled) return;
    if (!video || !video.videoWidth) return;
    try {
      var w = small.width, h = small.height;
      sctx.drawImage(video, 0, 0, w, h);
      var frame = sctx.getImageData(0, 0, w, h);
      var d = frame.data;
      var x, y, i, lum, run, top, a, t;

      for (x = 0; x < w; x++) {
        top = h; run = 0;
        for (y = 0; y < h; y++) {
          i = (y * w + x) * 4;
          lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          if (lum < SKY_EDGE) {
            run++;
            if (run >= RUN) { top = y - run + 1; break; }
          } else { run = 0; }
        }

        /* RGB is left alone on purpose: this canvas is only ever a destination-in source, so
           nothing but its alpha channel is ever read back out of it. */
        for (y = 0; y < h; y++) {
          i = (y * w + x) * 4;
          if (y < top || rowAlpha[y] === 0) { d[i + 3] = 0; continue; }
          lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          a = 1;
          if (lum > SOFT_LO) {
            t = clamp01((lum - SOFT_LO) / (SOFT_HI - SOFT_LO));
            a = 1 - (1 - FLOOR) * t;
          }
          d[i + 3] = (a * rowAlpha[y] * MAX_A * 255 + 0.5) | 0;
        }
      }
      sctx.putImageData(frame, 0, 0);

      /* The frame itself is drawn at full resolution and only the matte is small. That keeps the
         redrawn house exactly as sharp as the video under it, while the browser's own smoothing
         on the way up feathers the keyed edge for free, which is the one place softness is
         wanted. Drawing the small keyed image straight up would soften the whole house. */
      if (canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        wash = null;   /* the gradient is built against a height that just changed */
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

      /* The scrim in the stylesheet sits under this canvas, so it darkens the video but not the
         copy of the house drawn here, and the house would read brighter than the sky it stands
         in. Painting the same wash straight onto what survived the matte puts the two back in
         step. source-atop keeps it inside the matte, so it never spills into the keyed sky.
         These stops mirror .film-scrim's linear gradient in styles.css: change one, change both. */
      if (!wash) {
        wash = ctx.createLinearGradient(0, 0, 0, canvas.height);
        wash.addColorStop(0, "rgba(10,10,12,.52)");
        wash.addColorStop(0.32, "rgba(10,10,12,.18)");
        wash.addColorStop(0.54, "rgba(10,10,12,0)");
      }
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
    } catch (e) {
      /* a tainted canvas never untaints, and anything else reaching here is just as unrecoverable
         for what this does, so go dark for good rather than retry on every future seek */
      disable();
    }
  }

  function disable() {
    armed = false;
    enabled = false;
    if (canvas) {
      canvas.classList.remove("armed");
      try { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {}
    }
  }

  window.RROcclude = {
    init: function (opts) {
      if (!opts || !opts.video || !opts.canvas || !opts.canvas.getContext) return false;
      video = opts.video;
      canvas = opts.canvas;
      if (typeof opts.cutoff === "number") CUTOFF = opts.cutoff;
      if (typeof opts.skyEdge === "number") SKY_EDGE = opts.skyEdge;

      var vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
      small = document.createElement("canvas");
      small.width = SAMPLE_W;
      small.height = Math.max(1, Math.round(SAMPLE_W * vh / vw));
      /* willReadFrequently steers this at a CPU surface rather than re-reading from the GPU every
         call, which is exactly the pattern getImageData on every seek produces */
      sctx = small.getContext("2d", { willReadFrequently: true });
      ctx = canvas.getContext("2d");
      if (!sctx || !ctx) return false;

      canvas.width = vw; canvas.height = vh;
      buildRowAlpha(small.height);

      armed = true; enabled = true;
      /* this first paint doubles as the test of whether the pixels can be read here at all */
      paint();
      if (armed) canvas.classList.add("armed");
      return armed;
    },

    update: paint,

    setEnabled: function (on) {
      if (!armed) return;
      enabled = !!on;
      canvas.classList.toggle("armed", enabled);
      if (!enabled) { try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (e) {} }
      else paint();
    },

    get ok() { return armed && enabled; },

    destroy: function () { disable(); video = null; small = null; sctx = null; }
  };
})();
