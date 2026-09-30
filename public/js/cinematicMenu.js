// @ts-check
/**
 * DE.25 cinematic menu — one component.
 *
 *   CENTER  scroll-linked image sequence on a single <canvas>
 *   RIGHT   editorial product card stack (category → active product)
 *
 * Both are driven by ONE master progress value (0 → 1):
 *
 *   GSAP ScrollTrigger (scrub) → master.progress
 *        → requestAnimationFrame render()
 *             ├─ frame index  → canvas (repaint only if the frame changed)
 *             ├─ category     → panel group crossfade
 *             ├─ active card  → card stack transforms
 *             └─ progress line
 *
 * No scroll handler touches the DOM or canvas directly, and there is no
 * framework state: everything is written imperatively inside render().
 *
 * Mount point (public/index.html):
 *   <section data-cinematic-menu data-manifest="/frames/manifest.json"></section>
 */
import { api } from "./api.js";
import { escapeHtml, formatCurrency } from "./utils.js";
import { openProductDetail } from "./productDetail.js";

// ===========================================================================
// TUNING — everything you'd adjust lives here
// ===========================================================================

/**
 * CINEMATIC SPEED. How far the user scrolls (in viewport heights) to play the
 * whole film. The canvas is pinned (sticky) for exactly this distance.
 * Increase to make the film AND the menu slower; decrease to make both faster.
 * (Everything shares one progress value, so they always stay in sync.)
 */
const SCROLL_LENGTH_VH = 1300;

/**
 * Smoothing between scroll position and master progress, in seconds
 * (GSAP ScrollTrigger `scrub`). 0 = locked to the scrollbar; higher = the
 * film glides to catch up. 0.6 s still glides but stops close to when the
 * scrolling does; above ~1 s fast scrolls feel like the film is lagging.
 */
const SCRUB_SECONDS = 0.6;

/**
 * The blend between two neighbouring frames is continuous (see drawAt); the
 * canvas skips a repaint only when the playhead moved less than this many
 * frames — i.e. when it has stopped. Anything coarser makes slow scrolls
 * repaint every 2nd–4th screen frame, which reads as stutter.
 */
const REPAINT_EPSILON = 1 / 512;

/**
 * CATEGORY TIMING, written as frame numbers of the full 185-frame film
 * (global index across public/frames/manifest.json) so it can be checked
 * against the footage. Each category starts at the crossfade midpoint where
 * its product appears on screen.
 *   0–52     shop entrance → DE.25 wall
 *   53–90    blueberry cheesecake
 *   91–124   boxed dessert
 *   125–166  Korean bun
 *   167–177  chocolate shake
 *   178–184  final frames
 * Move a boundary by changing its frame number.
 */
const REFERENCE_FRAME_COUNT = 185;
const at = (/** @type {number} */ frame) => frame / (REFERENCE_FRAME_COUNT - 1);
const TIMELINE = [
  { key: "intro", from: 0, to: at(53) },
  { key: "cakes", from: at(53), to: at(91) },
  { key: "pastries", from: at(91), to: at(125) },
  { key: "savouries", from: at(125), to: at(167) },
  { key: "sips", from: at(167), to: at(178) },
  { key: "final", from: at(178), to: 1 },
];

/** Width (in progress units) of the crossfade between two category groups. */
const CATEGORY_FADE = 0.02;

/** How many cards show stacked behind the front card. */
const DECK_DEPTH = 3;

/**
 * CARD STACK SPEED. Within a category, each product gets an equal slice of
 * that category's range. For the first CARD_HOLD of its slice the product
 * sits still as the active card; the remaining part animates the next card
 * into place. Higher = cards hold longer and switch faster.
 */
const CARD_HOLD = 0.55;

/** Categories on the menu, in play order. Products are listed by ID only —
 *  names, prices, descriptions and images come from /api/products. Any
 *  product not listed here is appended to its category in data order. */
const MENU = [
  { key: "cakes", label: "Cakes", ids: ["blueberry-cheesecake", "dark-chocolate-cake", "fruit-cake"] },
  {
    key: "pastries",
    label: "Pastries",
    ids: [
      "classic-cheesecake", "nutella-cheesecake", "tiramisu", "chocolate-truffle-loaf",
      "chocolate-crunch-mousse-cake", "ragi-jaggery-brownie", "classic-chocolate-brownie", "nutella-brownie",
    ],
  },
  { key: "savouries", label: "Savouries", ids: ["korean-bun", "loaded-nachos"] },
  { key: "sips", label: "Sips", ids: ["hot-chocolate", "chocolate-milkshake"] },
];

/** Below this width: every second frame, the smaller frame variant, and the
 *  stacked mobile layout. */
const MOBILE_BREAKPOINT = 768;
const MAX_DPR = 2;
/** Space (CSS px) kept between the film's open area and the menu column. */
const FRAME_GAP = 24;

/**
 * PRELOAD EVERYTHING + PRE-DECODING.
 * The film does not start until EVERY frame is downloaded (≈10 MB desktop,
 * ≈3.4 MB phones), so nothing is ever missing mid-scroll; the loader shows
 * the real count. Frames within DECODE_BEHIND/AHEAD of the playhead are kept
 * decoded (ImageBitmap, canvas size) so scrolling never waits on a decode;
 * others are released to bound memory (decoding all ~430 at once would need
 * over 1 GB). Smaller screens keep a shorter window.
 */
/** Phones/tablets: share of the frame's width shown across the screen.
 *  0.62 fits the whole product (the widest is ~49% of the frame) with room
 *  around it. Lower = bigger/closer, higher = smaller/wider view. */
const MOBILE_VISIBLE = 0.62;
/** Widest the film is ever decoded/drawn (device px). */
const MAX_BACKING_W = 1600;
const LOAD_CONCURRENCY = 6;
const DECODE_CONCURRENCY = 4;
/** Preview tier: a small copy of every 2nd frame (neighbours cover the gaps),
 *  so fast scrolls never freeze — ≈50 MB for the whole film on desktop. */
const PREVIEW_W = 320;
const PREVIEW_CONCURRENCY = 2;
const DECODE_AHEAD = 24;
const DECODE_BEHIND = 10;
const DECODE_AHEAD_SMALL = 16;
const DECODE_BEHIND_SMALL = 6;
/** Width (CSS px) of the soft fade where the frame meets the backdrop fill. */
const FEATHER = 72;

// ===========================================================================

/** @typedef {{ productId: string, name: string, category: string, price: number, image?: string, description?: string, variants?: { label: string, price: number }[] }} Product */
/** @typedef {{ el: HTMLElement, from: number, to: number, cards: HTMLElement[], dots: HTMLElement[], fill: HTMLElement | null, cardKeys: string[], last: string }} Group */

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));
const smooth = (/** @type {number} */ t) => t * t * (3 - 2 * t); // smoothstep easing for card moves

/**
 * The product's own photo. DE.25's .jpg photos each have a .webp sibling;
 * anything else (e.g. an .svg) is served as-is — same rule as menu.js.
 * @param {Product} p
 */
function productImage(p) {
  if (!p.image) return "";
  const src = escapeHtml(p.image);
  const img = `<img src="${src}" alt="${escapeHtml(p.name)}" loading="lazy" decoding="async" width="400" height="400">`;
  if (!/\.jpg$/i.test(p.image)) return img;
  return `<picture><source type="image/webp" srcset="${escapeHtml(p.image.replace(/\.jpg$/i, ".webp"))}">${img}</picture>`;
}

/** @param {Product} p */
function priceLabel(p) {
  if (Array.isArray(p.variants) && p.variants.length) return `From ${formatCurrency(Math.min(...p.variants.map((v) => v.price)))}`;
  return formatCurrency(p.price);
}

export async function initCinematicMenu() {
  const found = /** @type {HTMLElement | null} */ (document.querySelector("[data-cinematic-menu]"));
  if (!found) return;
  const root = found;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const animated = !reducedMotion && !!gsap && !!ScrollTrigger;

  // ---- Static shell ---------------------------------------------------------
  root.classList.add("cm");
  root.classList.toggle("is-static", !animated);
  if (animated) root.style.height = `${SCROLL_LENGTH_VH + 100}vh`;
  root.innerHTML = `
    <div class="cm__stage">
      <div class="cm__layout">
        <div class="cm__film">
          <canvas class="cm__canvas" role="img" aria-label="${escapeHtml(root.dataset.label || "DE.25 film")}"></canvas>
          <div class="cm__loader" role="status"><p class="cm__loader-mark">DE.25</p><p class="cm__loader-text">Loading…</p></div>
          <div class="cm__progress" aria-hidden="true"><span></span></div>
        </div>
        <aside class="cm__panel" aria-label="Menu">
          <section class="cm__group cm__group--intro" data-key="intro">
            <p class="cm__kicker">Ghansoli &middot; Navi Mumbai</p>
            <h2 class="cm__brand">DE.25</h2>
            <p class="cm__sub">by Harshali</p>
            <p class="cm__line">Cakes &middot; Pastries &middot; Savouries &middot; Sips</p>
            <p class="cm__cue" aria-hidden="true">Scroll to explore the menu <span></span></p>
          </section>
          <section class="cm__group cm__group--final" data-key="final">
            <p class="cm__kicker">Wednesday to Sunday &middot; 7:30 PM &ndash; 11:30 PM</p>
            <h2 class="cm__brand">DE.25</h2>
            <p class="cm__sub">by Harshali</p>
            ${animated ? `<button type="button" class="cm__cta" data-jump="cakes">Browse the menu <span aria-hidden="true">&uarr;</span></button>` : ""}
          </section>
        </aside>
      </div>
    </div>`;

  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector(".cm__canvas"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", { alpha: false }));
  const loader = /** @type {HTMLElement} */ (root.querySelector(".cm__loader"));
  const loaderText = /** @type {HTMLElement} */ (root.querySelector(".cm__loader-text"));
  const progressFill = /** @type {HTMLElement} */ (root.querySelector(".cm__progress span"));
  const panel = /** @type {HTMLElement} */ (root.querySelector(".cm__panel"));

  // The sticky masthead sits over the top of the sticky stage; measure it so
  // the stage can pad itself clear of it at every breakpoint.
  const header = document.getElementById("site-header");
  const measureHeader = () => root.style.setProperty("--cm-header", `${header ? header.offsetHeight : 0}px`);
  measureHeader();

  // ---- Product data (existing API) → category groups ------------------------
  /** @type {Group[]} */
  const groups = [];
  try {
    const { products } = /** @type {{ products: Product[] }} */ (await api.getProducts());
    const finalGroup = /** @type {HTMLElement} */ (panel.querySelector('[data-key="final"]'));
    MENU.forEach((cat, ci) => {
      const inCat = products.filter((p) => p.category === cat.key);
      const ordered = [
        ...cat.ids.map((id) => inCat.find((p) => p.productId === id)).filter((p) => p !== undefined),
        ...inCat.filter((p) => !cat.ids.includes(p.productId)),
      ];
      if (!ordered.length) return;
      const el = document.createElement("section");
      el.className = "cm__group";
      el.dataset.key = cat.key;
      el.setAttribute("aria-label", cat.label);
      el.innerHTML = `
        <header class="cm__head">
          <p class="cm__kicker">Menu &middot; ${String(ci + 1).padStart(2, "0")} / ${String(MENU.length).padStart(2, "0")}</p>
          <h2 class="cm__title">${escapeHtml(cat.label)}</h2>
        </header>
        <div class="cm__deck">
          <div class="cm__timeline" aria-hidden="true">
            <span class="cm__timeline-track"><span class="cm__timeline-fill"></span></span>
            ${ordered.map(() => `<span class="cm__dot"></span>`).join("")}
          </div>
          <div class="cm__stack">
            ${ordered
              .map(
                (p, i) => `
              <article class="cm__card">
                <div class="cm__card-inner">
                  <div class="cm__card-media">${productImage(p)}</div>
                  <div class="cm__card-body">
                    <p class="cm__card-index">${String(i + 1).padStart(2, "0")} / ${String(ordered.length).padStart(2, "0")}</p>
                    <h3 class="cm__card-name">${escapeHtml(p.name)}</h3>
                    <p class="cm__card-price">${priceLabel(p)}</p>
                    ${p.description ? `<p class="cm__card-desc">${escapeHtml(p.description)}</p>` : ""}
                    <button type="button" class="cm__more" data-product-id="${escapeHtml(p.productId)}" aria-label="View more about ${escapeHtml(p.name)}">View more <span aria-hidden="true">&rarr;</span></button>
                  </div>
                </div>
              </article>`
              )
              .join("")}
          </div>
        </div>`;
      panel.insertBefore(el, finalGroup);
    });
  } catch {
    // Menu data unavailable — the film still plays; the intro/final panels stay.
  }

  // A card photo that fails to load leaves a quiet paper block, never a
  // broken-image icon. (error doesn't bubble, so listen in the capture phase.)
  panel.addEventListener(
    "error",
    (e) => {
      const media = e.target instanceof HTMLImageElement ? e.target.closest(".cm__card-media") : null;
      if (media) media.classList.add("is-missing");
    },
    true
  );

  // View More → the site's existing product detail (image, price, qty, Add to Cart).
  panel.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("[data-product-id]");
    if (btn instanceof HTMLElement && btn.dataset.productId) openProductDetail(btn.dataset.productId);
  });

  panel.querySelectorAll(".cm__group").forEach((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const t = TIMELINE.find((x) => x.key === el.dataset.key);
    if (!t) return;
    groups.push({
      el,
      from: t.from,
      to: t.to,
      cards: /** @type {HTMLElement[]} */ ([...el.querySelectorAll(".cm__card")]),
      dots: /** @type {HTMLElement[]} */ ([...el.querySelectorAll(".cm__dot")]),
      fill: /** @type {HTMLElement | null} */ (el.querySelector(".cm__timeline-fill")),
      cardKeys: /** @type {string[]} */ ([]),
      last: "",
    });
  });

  // ---- Frames ---------------------------------------------------------------
  /** @type {string[]} */
  let urls = [];
  let manifestW = 0;
  let manifestH = 0;
  let staticFrame = 0;
  const small = window.innerWidth < MOBILE_BREAKPOINT;
  try {
    const res = await fetch(root.dataset.manifest || "/frames/manifest-smooth.json");
    /** @type {{ width?: number, height?: number, variants?: Record<string, { width: number, height: number }>, sequences: { sequence: number, startIndex: number, frameCount: number, frames: string[], framesMobile?: string[] }[] }} */
    const manifest = await res.json();
    const seqs = manifest.sequences.sort((a, b) => a.sequence - b.sequence);
    // Phones get the smaller variant of the same frames, when the manifest has one.
    const mobile = small && seqs.every((s) => s.framesMobile && s.framesMobile.length === s.frames.length);
    urls = seqs.flatMap((s) => (mobile ? /** @type {string[]} */ (s.framesMobile) : s.frames));
    const size = mobile && manifest.variants && manifest.variants.m ? manifest.variants.m : manifest;
    manifestW = size.width || 0;
    manifestH = size.height || 0;
    // Reduced-motion still: the last frame of the opening scene (the DE.25 wall).
    staticFrame = seqs[0] ? seqs[0].startIndex + seqs[0].frameCount - 1 : 0;
  } catch {
    loaderText.textContent = "The film couldn't load.";
  }
  if (!animated) {
    urls = urls.length ? [urls[clamp(staticFrame, 0, urls.length - 1)]] : [];
  } else if (small) {
    const last = urls.length - 1; // every second frame, always keeping the final one
    urls = urls.filter((_, i) => i % 2 === 0 || i === last);
  }

  const frameCount = urls.length;
  const film = /** @type {HTMLElement} */ (root.querySelector(".cm__film"));
  const isSmall = window.innerWidth < MOBILE_BREAKPOINT;
  const WINDOW_AHEAD = isSmall ? DECODE_AHEAD_SMALL : DECODE_AHEAD;
  const WINDOW_BEHIND = isSmall ? DECODE_BEHIND_SMALL : DECODE_BEHIND;

  // ===========================================================================
  // FRAME STORE — lazy network loading + a sliding window of pre-decoded frames
  // ===========================================================================
  /** Compressed frame bytes (≈40 KB each). Decoding from a Blob runs off the
   *  main thread; decoding from an <img> would block scrolling. @type {(Blob | null)[]} */
  const blobs = new Array(frameCount).fill(null);
  /** 0 idle · 1 loading · 2 loaded · 3 failed */
  const netState = new Uint8Array(frameCount);
  /** Decoded, canvas-sized frames near the playhead. @type {Map<number, ImageBitmap | HTMLImageElement>} */
  const bitmaps = new Map();
  const canBitmap = typeof createImageBitmap === "function";
  const decoding = new Set();
  /** Each frame's backdrop colours (top edge, bottom edge) for the CSS fill. */
  const edgeTop = new Array(frameCount).fill("");
  const edgeBottom = new Array(frameCount).fill("");
  /** Small copies of EVERY frame (PREVIEW_W wide), decoded once in the
   *  background. When a fast scroll outruns the sharp window, the film shows
   *  the right frame at preview resolution instead of freezing on an old one.
   *  @type {(ImageBitmap | null)[]} */
  const previews = new Array(frameCount).fill(null);
  const previewing = new Set();
  let focus = 0; // frame the playhead is on
  let direction = 1; // +1 scrolling forward, -1 back — the sharp window leads this way
  let inFlight = 0;
  let loadedCount = 0;
  let framesReady = false;
  let bitmapW = 0; // decode size = canvas backing size
  let bitmapH = 0;
  let bitmapGen = 0; // bumped on resize so stale decodes are discarded

  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 16;
  sampleCanvas.height = 9;
  const sampleCtx = /** @type {CanvasRenderingContext2D} */ (sampleCanvas.getContext("2d", { willReadFrequently: true }));

  /** Sample a frame's top/bottom backdrop colours once, from its first decode. */
  function sampleEdges(/** @type {number} */ i, /** @type {CanvasImageSource} */ src) {
    if (edgeTop[i]) return;
    sampleCtx.drawImage(src, 0, 0, 16, 9);
    const d = sampleCtx.getImageData(0, 0, 16, 9).data;
    /** @param {number} row */
    const avg = (row) => {
      let r = 0, g = 0, b = 0;
      for (let x = 0; x < 16; x++) {
        const k = (row * 16 + x) * 4;
        r += d[k]; g += d[k + 1]; b += d[k + 2];
      }
      return `rgb(${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)})`;
    };
    edgeTop[i] = avg(0);
    edgeBottom[i] = avg(8);
  }

  /** LAZY LOADING: fetch the not-yet-loaded frame nearest the playhead next
   *  (a little ahead of it first), a few at a time, until all are in. */
  function pumpNetwork() {
    while (inFlight < LOAD_CONCURRENCY) {
      let next = -1;
      for (let d = 0; d < frameCount && next < 0; d++) {
        for (const k of [focus + d, focus - d - 1]) {
          if (k >= 0 && k < frameCount && netState[k] === 0) { next = k; break; }
        }
      }
      if (next < 0) return;
      const i = next;
      netState[i] = 1;
      inFlight++;
      fetch(urls[i])
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
        .then((blob) => {
          inFlight--;
          netState[i] = 2;
          blobs[i] = blob;
          loadedCount++;
          if (!framesReady) loaderText.textContent = `Loading ${Math.min(loadedCount, startCount)} of ${startCount}`;
          pumpDecode();
          pumpNetwork();
          checkReady();
        })
        .catch(() => {
          inFlight--;
          netState[i] = 3; // a missing frame: the nearest decoded one is shown instead
          pumpNetwork();
          checkReady();
        });
    }
  }

  /** PRE-DECODING: keep canvas-sized ImageBitmaps for the frames around the
   *  playhead (decoded off the main thread), and release the rest. */
  function pumpDecode() {
    if (!bitmapW) return;
    // The window leads in the direction of travel (scrolling back up gets
    // the same look-ahead as scrolling down).
    const lo = Math.max(0, focus - (direction > 0 ? WINDOW_BEHIND : WINDOW_AHEAD));
    const hi = Math.min(frameCount - 1, focus + (direction > 0 ? WINDOW_AHEAD : WINDOW_BEHIND));
    for (const [k, bmp] of bitmaps) {
      if (k < lo || k > hi) { release(bmp); bitmaps.delete(k); }
    }
    // Nearest first, leading side first.
    for (let d = 0; d <= Math.max(WINDOW_AHEAD, WINDOW_BEHIND) && decoding.size < DECODE_CONCURRENCY; d++) {
      for (const k of [focus + d * direction, focus - d * direction]) {
        if (k < lo || k > hi || bitmaps.has(k) || decoding.has(k) || netState[k] !== 2) continue;
        if (decoding.size >= DECODE_CONCURRENCY) break;
        decodeFrame(k);
      }
    }
    pumpPreviews();
  }

  /** Background: decode a small preview of every downloaded frame, nearest
   *  the playhead first, on its own small pool so it never delays the sharp
   *  frames. */
  function pumpPreviews() {
    if (!canBitmap) return;
    for (let d = 0; d < frameCount && previewing.size < PREVIEW_CONCURRENCY; d++) {
      for (const k of [focus + d * direction, focus - d * direction]) {
        if (k < 0 || k >= frameCount || k % 2 !== 0 || previews[k] || previewing.has(k) || netState[k] !== 2) continue;
        if (previewing.size >= PREVIEW_CONCURRENCY) break;
        const blob = blobs[k];
        if (!blob) continue;
        previewing.add(k);
        const h = Math.round((PREVIEW_W * srcH) / srcW);
        createImageBitmap(blob, /** @type {ImageBitmapOptions} */ ({ resizeWidth: PREVIEW_W, resizeHeight: h, resizeQuality: "medium" }))
          .then((bmp) => {
            previewing.delete(k);
            previews[k] = bmp;
            sampleEdges(k, bmp);
            // Only matters if the sharp frame isn't there yet.
            if (framesReady && !bitmaps.has(k) && (k === Math.floor(lastPos) || k === Math.floor(lastPos) + 1)) { renderedFrame = -1; requestRender(); }
            pumpPreviews();
          })
          .catch(() => previewing.delete(k));
      }
    }
  }

  /** @param {ImageBitmap | HTMLImageElement} src */
  function release(src) {
    if ("close" in src) src.close();
    else if (src.src.startsWith("blob:")) URL.revokeObjectURL(src.src);
  }

  /** Decode one frame to canvas size, off the main thread. */
  function decodeFrame(/** @type {number} */ k) {
    const blob = blobs[k];
    if (!blob) return;
    const gen = bitmapGen;
    decoding.add(k);
    /** @type {Promise<ImageBitmap | HTMLImageElement>} */
    const job = canBitmap
      ? createImageBitmap(blob, /** @type {ImageBitmapOptions} */ ({ resizeWidth: bitmapW, resizeHeight: bitmapH, resizeQuality: "high" }))
          .catch(() => createImageBitmap(blob)) // browsers without resize options
      : new Promise((resolve, reject) => {
          // Very old browsers: an <img> from the blob (decoded async).
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = URL.createObjectURL(blob);
        });
    job
      .then((src) => {
        decoding.delete(k);
        if (gen !== bitmapGen) { release(src); pumpDecode(); return; }
        bitmaps.set(k, src);
        sampleEdges(k, src);
        if (!framesReady) checkReady();
        // The frame on screen (or the one it blends into) just became ready.
        else if (k === Math.floor(lastPos) || k === Math.floor(lastPos) + 1) { renderedFrame = -1; requestRender(); }
        pumpDecode();
      })
      .catch(() => { decoding.delete(k); });
  }

  /** Best thing to draw for frame i, never waiting on a decode:
   *  1. its sharp decoded frame
   *  2. its preview (the RIGHT frame, softer — keeps fast scrolls moving)
   *  3. the nearest sharp frame, else the nearest preview */
  function drawable(/** @type {number} */ i) {
    const exact = bitmaps.get(i);
    if (exact) return exact;
    if (previews[i]) return previews[i];
    let best = null, bestD = Infinity;
    for (const [k, bmp] of bitmaps) {
      const d = Math.abs(k - i);
      if (d < bestD) { best = bmp; bestD = d; }
    }
    if (best && bestD <= 2) return best;
    for (let d = 1; d < frameCount; d++) {
      const p = previews[i - d] || previews[i + d];
      if (p) return p;
    }
    return best;
  }

  // Start as soon as the opening frames are in; the rest keep streaming.
  // No lazy start: wait for every frame (the loader counts them in).
  const startCount = frameCount;
  function checkReady() {
    if (framesReady) return;
    let settled = 0;
    for (let i = 0; i < startCount; i++) if (netState[i] >= 2) settled++;
    if (settled < startCount) return;
    if (!blobs.some(Boolean)) {
      loaderText.textContent = "The film couldn't load.";
      return;
    }
    if (!bitmaps.size) { pumpDecode(); return; } // wait for the first decoded frame
    framesReady = true;
    loader.hidden = true;
    renderedFrame = -1;
    requestRender();
  }

  // ===========================================================================
  // LAYOUT + DRAWING
  // ===========================================================================
  let renderedFrame = -1;
  let canvasDirty = true;
  let lastPos = 0;
  let bgFrame = -1;
  const srcW = manifestW || 1920;
  const srcH = manifestH || 1080;

  /**
   * FULL FIT, NO SEAMS — layout is done once per resize, not per frame.
   *  - The canvas is exactly the size of the fitted frame (object-fit:
   *    contain against the film area — never cropped, never stretched): on
   *    wide screens it fills the full height and its plain backdrop edge runs
   *    under the menu column.
   *  - It's centred on the open area left of the menu where possible, never
   *    pushed past the left edge (that would crop it).
   *  - Space it doesn't cover shows the film's CSS background: the current
   *    frame's own backdrop colours. Edges that don't touch the film edge
   *    fade into it with a CSS mask (GPU-composited: costs nothing per frame).
   */
  function layout() {
    const fr = film.getBoundingClientRect();
    const pn = panel.getBoundingClientRect();
    const menuOverFilm = pn.left > fr.left + fr.width / 2 && pn.left < fr.right && pn.top < fr.bottom && pn.bottom > fr.top;
    const openW = menuOverFilm ? Math.max(fr.width / 2, pn.left - fr.left - FRAME_GAP) : fr.width;

    // Desktop (menu beside the film): the whole frame, never cropped.
    // Phones/tablets: the photo spans the full width at the top, zoomed so
    // MOBILE_VISIBLE of the frame's width shows — enough for the whole
    // product (the widest, the cheesecake, is ~49% of the frame) — and its
    // bottom edge fades into the dark sheet the menu sits on.
    const contain = Math.min(fr.width / srcW, fr.height / srcH);
    const cover = Math.max(fr.width / srcW, fr.height / srcH);
    const s = menuOverFilm ? contain : clamp(fr.width / (srcW * MOBILE_VISIBLE), contain, cover);
    const w = Math.round(srcW * s);
    const h = Math.round(srcH * s);
    const x = menuOverFilm ? Math.round(clamp(openW / 2 - w / 2, 0, fr.width - w)) : Math.round((fr.width - w) / 2);
    const y = menuOverFilm ? Math.round((fr.height - h) / 2) : 0;
    Object.assign(canvas.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    film.style.setProperty("--cm-frame-top", `${Math.max(0, y)}px`);
    film.style.setProperty("--cm-frame-end", `${Math.min(fr.height, y + h)}px`);
    // The menu on phones starts where the photo ends (CSS reads this).
    root.style.setProperty("--cm-photo-h", `${Math.min(fr.height, y + h)}px`);

    const fades = [];
    if (x > 1) fades.push(`linear-gradient(to right, transparent, #000 ${FEATHER}px)`);
    if (x + w < fr.width - 1) fades.push(`linear-gradient(to left, transparent, #000 ${FEATHER}px)`);
    if (y > 1) fades.push(`linear-gradient(to bottom, transparent, #000 ${FEATHER}px)`);
    if (y + h < fr.height - 1) fades.push(`linear-gradient(to top, transparent, #000 ${FEATHER}px)`);
    const mask = fades.length ? fades.join(", ") : "none";
    canvas.style.setProperty("mask-image", mask);
    canvas.style.setProperty("-webkit-mask-image", mask);
    canvas.style.setProperty("mask-composite", fades.map(() => "intersect").join(", ") || "add");
    canvas.style.setProperty("-webkit-mask-composite", fades.map(() => "source-in").join(", ") || "source-over");

    // Backing store: device pixels, but never more than the source has, and
    // capped at MAX_BACKING_W — these are soft video frames, so more pixels
    // add no visible detail, only decode/upload work while scrolling.
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR, srcW / Math.max(1, w), MAX_BACKING_W / Math.max(1, w));
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    canvas.width = bw;
    canvas.height = bh;
    ctx.imageSmoothingQuality = "high";

    // Decoded bitmaps are canvas-sized, so a new size means re-decoding.
    if (bw !== bitmapW || bh !== bitmapH) {
      bitmapW = bw;
      bitmapH = bh;
      bitmapGen++;
      for (const bmp of bitmaps.values()) release(bmp);
      bitmaps.clear();
      pumpDecode();
    }
    bgFrame = -1;
  }

  /** The film's background takes the frame's own backdrop colours. */
  function setBackdrop(/** @type {number} */ i) {
    let k = -1;
    for (let d = 0; d < frameCount && k < 0; d++) {
      if (edgeTop[i - d]) k = i - d;
      else if (edgeTop[i + d]) k = i + d;
    }
    if (k < 0 || k === bgFrame) return;
    bgFrame = k;
    film.style.setProperty("--cm-bg-top", edgeTop[k]);
    film.style.setProperty("--cm-bg-bottom", edgeBottom[k]);
  }

  /**
   * SMOOTHNESS. The film has fewer frames than the scroll has positions, so
   * between two frames the next one is blended over the current one with a
   * CONTINUOUS weight (how far we are between them) — while the playhead is
   * moving, the picture changes on every screen frame, however slowly you
   * scroll. It repaints only when the playhead actually moved (see
   * REPAINT_EPSILON); each repaint is at most two drawImage calls of
   * pre-decoded, canvas-sized bitmaps.
   * @param {number} pos fractional frame position, 0 … frameCount - 1
   */
  function drawAt(pos) {
    lastPos = pos;
    const i0 = Math.floor(pos);
    const t = pos - i0;
    if (i0 !== focus) {
      direction = i0 > focus ? 1 : -1;
      focus = i0;
      pumpDecode();
      pumpNetwork();
    }
    const key = pos;
    if (renderedFrame >= 0 && Math.abs(key - renderedFrame) < REPAINT_EPSILON) return; // stopped: nothing to repaint
    const a = drawable(i0);
    if (!a) return;
    ctx.globalAlpha = 1;
    ctx.drawImage(a, 0, 0, canvas.width, canvas.height);
    const b = t > 0 && i0 + 1 < frameCount ? drawable(i0 + 1) : null;
    if (b && b !== a) {
      ctx.globalAlpha = t;
      ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
    setBackdrop(t >= 0.5 ? i0 + 1 : i0);
    renderedFrame = key;
  }

  // ---- Card stack geometry (from CSS custom properties, per breakpoint) -------
  let cardH = 380;
  let depthY = 16;
  function readGeometry() {
    // --cm-card-h is a clamp() of the screen height, so measure a real card
    // (offsetHeight ignores transforms) rather than parse the CSS value.
    const card = /** @type {HTMLElement | null} */ (panel.querySelector(".cm__card"));
    if (card && card.offsetHeight) cardH = card.offsetHeight;
    depthY = parseFloat(getComputedStyle(panel).getPropertyValue("--cm-depth-y")) || depthY;
  }
  readGeometry();

  /**
   * SCROLL STACK DECK. Pose for a card `d` positions from the front one
   * (d = 0 front, 1 directly behind, -1 already peeled away; fractional
   * while moving). Returns [translateY px, scale, rotateX deg, rotateZ deg,
   * opacity, content dim, shadow lift, z-index].
   *
   *   behind (d > 0)  stacked behind the front card, each layer a little
   *                   smaller and DEPTH_Y higher, so its top edge shows
   *   front  (d = 0)  full size, full shadow
   *   peel   (d < 0)  lifts up, tips back and turns slightly as it fades —
   *                   the next card rises forward into its place
   * @param {number} d
   * @returns {[number, number, number, number, number, number, number, number]}
   */
  function cardPose(d) {
    if (d < 0) {
      const t = -d; // 0 → 1 as the front card peels away
      // Stays solid while it starts to lift (so nothing shows through it),
      // then fades once it has moved clear.
      return [-t * cardH * 0.6, 1 + t * 0.02, t * 24, -t * 5, clamp(1 - (t - 0.3) / 0.55, 0, 1), 1, 1, 300];
    }
    const depth = Math.min(d, DECK_DEPTH);
    const opacity = clamp((DECK_DEPTH + 0.6 - d) / 0.6, 0, 1); // layers past the deck fade out
    // Cards behind show only their clean edges; contents fade in as a card
    // rises to the front (d 0.66 → 0), so no text ever shows through another card.
    const content = clamp(1 - d * 1.5, 0, 1);
    return [-depth * depthY, 1 - depth * 0.05, 0, 0, opacity, content, clamp(1 - d * 0.6, 0.15, 1), 200 - Math.round(d * 10)];
  }

  // ---- Master progress → everything ----------------------------------------
  const master = { progress: 0 };
  let rafId = 0;

  function render() {
    rafId = 0;
    const p = master.progress;

    // 1. FRAME. progress 0 → first frame, progress 1 → last frame, with the
    //    in-between positions blended (drawAt). Speed is SCROLL_LENGTH_VH:
    //    the same 0→1 spread over more scroll = slower.
    if (canvasDirty) {
      layout();
      canvasDirty = false;
      renderedFrame = -1;
    }
    if (framesReady) {
      drawAt(animated ? p * (frameCount - 1) : 0);
      progressFill.style.transform = `scaleX(${p})`;
    }
    if (!animated) return;

    // 2. CATEGORY + 3. ACTIVE PRODUCT + 4. CARD STACK — same p.
    for (const g of groups) {
      // Crossfade window centred on each boundary (none at the film's ends).
      const fadeIn = g.from <= 0 ? 1 : clamp((p - (g.from - CATEGORY_FADE / 2)) / CATEGORY_FADE, 0, 1);
      const fadeOut = g.to >= 1 ? 1 : clamp((g.to + CATEGORY_FADE / 2 - p) / CATEGORY_FADE, 0, 1);
      const vis = Math.min(fadeIn, fadeOut);
      const shift = (1 - fadeIn) * 28 - (1 - fadeOut) * 28; // in from below, out upward
      const key = `${vis.toFixed(3)}|${shift.toFixed(1)}`;
      if (key !== g.last) {
        g.last = key;
        g.el.style.opacity = String(vis);
        g.el.style.transform = `translate3d(0, ${shift}px, 0)`;
        const active = vis > 0.5;
        if (g.el.inert === active) g.el.inert = !active; // hidden groups aren't focusable
        g.el.classList.toggle("is-active", active);
      }
      if (!g.cards.length || vis === 0) continue;

      // Active product: equal slice per product; hold, then ease to the next.
      const n = g.cards.length;
      const t = clamp((p - g.from) / (g.to - g.from), 0, 0.9999);
      const slot = Math.floor(t * n);
      const f = t * n - slot;
      const activePos = slot >= n - 1 ? n - 1 : slot + smooth(clamp((f - CARD_HOLD) / (1 - CARD_HOLD), 0, 1));

      g.cards.forEach((card, k) => {
        const d = k - activePos;
        const [y, s, rx, rz, o, dim, lift, z] = cardPose(d);
        const hidden = o <= 0.01;
        const transform = `translate3d(0, ${y.toFixed(1)}px, 0) rotateX(${rx.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) scale(${s.toFixed(3)})`;
        const opacity = hidden ? "0" : o.toFixed(2);
        const dimS = dim.toFixed(2);
        const liftS = lift.toFixed(2);
        // Write only what changed: cards far from the front sit still, and
        // re-setting their styles every frame would repaint their shadows.
        const key = `${transform}|${opacity}|${dimS}|${liftS}|${z}`;
        if (g.cardKeys[k] === key) return;
        g.cardKeys[k] = key;
        card.style.transform = transform;
        card.style.opacity = opacity;
        card.style.zIndex = String(z);
        card.style.setProperty("--cm-dim", dimS);
        card.style.setProperty("--cm-lift", liftS);
        card.style.visibility = hidden ? "hidden" : "";
        const focusable = Math.abs(d) < 0.5;
        if (card.inert === focusable) card.inert = !focusable; // only the front card's button is tabbable
        card.classList.toggle("is-active", focusable);
      });

      // Timeline: one dot per product, the line fills to the front card.
      if (g.fill) g.fill.style.transform = `scaleY(${n > 1 ? (activePos / (n - 1)).toFixed(4) : 1})`;
      const current = Math.round(activePos);
      g.dots.forEach((dot, k) => {
        dot.classList.toggle("is-done", k < current);
        dot.classList.toggle("is-active", k === current);
      });
    }
  }

  const requestRender = () => {
    if (!rafId) rafId = requestAnimationFrame(render);
  };

  // ---- Reduced motion / no GSAP: static frame + plain menu list -------------
  if (!animated) {
    groups.forEach((g) => {
      g.el.inert = false;
      g.el.classList.add("is-active");
    });
  } else {
    // ONE master timeline. ScrollTrigger maps the section's scroll range to
    // master.progress 0 → 1. GSAP's scrub runs on its own animation-frame
    // ticker, so the film is drawn right there, in the same screen frame the
    // playhead moved — no second callback a frame later, which could land
    // updates unevenly (some screen frames with two, some with none).
    document.documentElement.classList.add("has-cinematic-menu"); // disables CSS smooth scroll (see cinematic.css)
    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.config({ ignoreMobileResize: true });
    const tween = gsap.to(master, {
      progress: 1,
      ease: "none",
      onUpdate: () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        render();
      },
      scrollTrigger: {
        trigger: root,
        start: "top top", // section top (tucked under the masthead) at viewport top
        end: "bottom bottom", // …until its bottom reaches the viewport bottom = SCROLL_LENGTH_VH of scroll
        scrub: SCRUB_SECONDS,
        invalidateOnRefresh: true,
      },
    });

    // "Browse the menu" (final panel): glide back to the start of a category
    // (just past its crossfade, so it's fully in).
    root.addEventListener("click", (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest("[data-jump]");
      const st = tween.scrollTrigger;
      const t = btn instanceof HTMLElement ? TIMELINE.find((x) => x.key === btn.dataset.jump) : undefined;
      if (!t || !st) return;
      const p = Math.min(1, t.from + CATEGORY_FADE);
      window.scrollTo({ top: st.start + p * (st.end - st.start), behavior: "smooth" });
    });
  }

  // Resize / orientation / DPR change: re-fit canvas + geometry, repaint once.
  new ResizeObserver(() => {
    measureHeader();
    readGeometry();
    canvasDirty = true;
    groups.forEach((g) => { g.last = ""; g.cardKeys = []; }); // geometry changed: rewrite everything
    requestRender();
  }).observe(film); // the film area, not the canvas — layout() sizes the canvas itself
  requestRender(); // panel is live even while frames load

  // ---- Lazy loading: start once the opening frames are in ------------------
  if (!frameCount) {
    loaderText.textContent = "The film couldn't load.";
    return;
  }
  pumpNetwork();
}
