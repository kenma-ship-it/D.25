/**
 * "From the kitchen" gallery — continuous auto-sliding photo strip.
 *
 * Without this script the strip is a plain swipeable row. With it, the set
 * of photos is cloned once (clones are aria-hidden + inert so screen readers
 * and keyboard users meet each photo only once), and a CSS transform
 * animation moves the strip by exactly one set width per loop — so the
 * wrap-around is invisible. Movement is transform-only (never scrollLeft or
 * scrollIntoView), so it can never drag the page scroll position with it.
 *
 * Pauses: hover and keyboard focus (CSS), touch (here), and whenever the
 * gallery is off screen (here — no point animating what nobody sees).
 * Visitors with "reduce motion" on still get the auto-slide, at a slower,
 * gentler speed, and every pause trigger above still applies.
 */
const PX_PER_SECOND = 38;
const REDUCED_PX_PER_SECOND = 16;
const TOUCH_RESUME_MS = 3500;

export function initGallerySlider() {
  const root = document.querySelector("[data-gallery]");
  const strip = root?.querySelector("[data-gallery-strip]");
  if (!root || !strip) return;

  const originals = Array.from(strip.children);
  if (originals.length < 2) return;

  // The strip only ever shows these photos, so load them all up front rather
  // than leaving lazy images to pop in blank as they slide into view.
  const eager = () => strip.querySelectorAll("img[loading=lazy]").forEach((img) => (img.loading = "eager"));

  originals.forEach((item) => {
    const clone = item.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("data-clone", "");
    clone.inert = true;
    clone.querySelectorAll("img").forEach((img) => (img.alt = ""));
    strip.appendChild(clone);
  });

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const measure = () => {
    // Every item carries its own trailing margin, so one set's width is
    // simply the offset where the first clone starts.
    const setWidth = strip.children[originals.length].offsetLeft - strip.children[0].offsetLeft;
    if (setWidth <= 0) return;
    root.style.setProperty("--gallery-set-width", `${setWidth}px`);
    root.style.setProperty("--gallery-duration", `${(setWidth / (reduced ? REDUCED_PX_PER_SECOND : PX_PER_SECOND)).toFixed(1)}s`);
  };

  root.classList.add("is-running");
  root.scrollLeft = 0;
  measure();
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(measure, 150);
  });
  // Images decoding can nudge widths on first paint; re-measure once loaded.
  window.addEventListener("load", measure, { once: true });

  let touchTimer;
  root.addEventListener("touchstart", () => {
    clearTimeout(touchTimer);
    root.classList.add("is-paused");
  }, { passive: true });
  root.addEventListener("touchend", () => {
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => root.classList.remove("is-paused"), TOUCH_RESUME_MS);
  }, { passive: true });

  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      ([entry]) => {
        root.classList.toggle("is-offscreen", !entry.isIntersecting);
        if (entry.isIntersecting) eager();
      },
      { rootMargin: "300px 0px" }
    );
    io.observe(root);
  } else {
    eager();
  }
}
