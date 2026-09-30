/**
 * Scroll/reveal animation core.
 *
 * The dependency-free IntersectionObserver path below is what actually
 * guarantees every [data-reveal] element becomes visible — nothing else on
 * the page depends on a CDN library succeeding. The optional Motion
 * enhancement (hero parallax) is layered on top via a dynamic import with
 * a .catch(): if that CDN is blocked, slow, or stripped by an ad blocker,
 * the hero and every other animation on the page keep working exactly as
 * they do without it.
 */
const prefersReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initReveals() {
  const nodes = Array.from(document.querySelectorAll("[data-reveal]"));

  // explicit per-element delays (hero sequence)
  nodes.forEach((el) => {
    if (el.dataset.revealDelay != null) el.style.setProperty("--reveal-delay", el.dataset.revealDelay);
  });

  // gentle auto-stagger for sibling groups (category cards, product grid),
  // capped at 8 items so a long menu doesn't take forever to finish revealing.
  const groups = new Map();
  nodes.forEach((el) => {
    if (el.dataset.revealDelay != null) return;
    const parent = el.parentElement;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(el);
  });
  groups.forEach((siblings) => {
    siblings.slice(0, 8).forEach((el, i) => el.style.setProperty("--reveal-delay", String(i)));
  });

  if (prefersReduced() || !("IntersectionObserver" in window)) {
    nodes.forEach((el) => el.classList.add("is-visible"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
  );
  nodes.forEach((el) => io.observe(el));
  // Safety net for elements that never intersect (very short pages, odd viewports).
  setTimeout(() => nodes.forEach((el) => el.classList.add("is-visible")), 4000);
}

/** Reveal newly-rendered nodes (e.g. after the menu grid re-renders on filter change). */
export function observeNewReveals(container) {
  const nodes = Array.from(container.querySelectorAll("[data-reveal]:not(.is-visible)"));
  if (nodes.length === 0) return;
  nodes.slice(0, 8).forEach((el, i) => el.style.setProperty("--reveal-delay", String(i)));
  if (prefersReduced() || !("IntersectionObserver" in window)) {
    nodes.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
  );
  nodes.forEach((el) => io.observe(el));
}

/** Toggles the header's on-dark styling while the hero is behind it. */
export function initHeaderOnDark() {
  const header = document.getElementById("site-header");
  const hero = document.querySelector(".hero");
  if (!header || !hero || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        header.classList.toggle("is-on-dark", entry.isIntersecting);
      });
    },
    { rootMargin: "-72px 0px 0px 0px", threshold: 0 }
  );
  io.observe(hero);
}

/**
 * Keeps the fixed Food Guide FAB (.ai-guide) from ever sitting on top of
 * the footer's Instagram link as the page scrolls to the bottom: it lifts
 * by exactly the amount the footer has crept up over its normal `bottom`
 * offset, and settles back to that CSS default once the footer is no
 * longer in the way.
 *
 * Lifting the FAB also lifts the chat panel that opens above it — on a
 * short mobile viewport, scrolled to the very bottom (exactly where the
 * FAB used to overlap the footer), that could push the panel's top edge
 * past the top of the screen, cutting off its header/close button. So
 * this also caps the panel's max-height (via the --ai-panel-max custom
 * property, consumed in styles.css) to whatever room is actually left
 * above the FAB, instead of a flat 70vh that assumes the FAB never moves.
 */
export function initAiGuideFooterDock() {
  const guide = document.getElementById("ai-guide");
  const fab = document.getElementById("ai-fab");
  const footer = document.querySelector(".site-footer");
  if (!guide || !fab || !footer) return;

  // The CSS default `bottom` changes at the <480px breakpoint (see
  // styles.css), so it's re-read on resize rather than hard-coded here.
  let baseBottom = 0;
  const readBase = () => {
    guide.style.bottom = "";
    baseBottom = parseFloat(getComputedStyle(guide).bottom) || 0;
  };

  const GAP = 12; // breathing room between the FAB and the footer's top edge
  const PANEL_GAP = 12; // matches .ai-panel's `bottom: calc(100% + 12px)`
  const SAFE_TOP = 8; // minimum gap to leave above the panel
  const MIN_PANEL_HEIGHT = 260; // below this the panel is no longer usable, so it's the floor

  let ticking = false;
  const update = () => {
    ticking = false;
    const rect = footer.getBoundingClientRect();
    const overlap = window.innerHeight - rect.top;
    const bottom = overlap > 0 ? baseBottom + overlap + GAP : baseBottom;
    guide.style.bottom = overlap > 0 ? `${bottom}px` : "";

    const fabHeight = fab.getBoundingClientRect().height || 52;
    const available = window.innerHeight - bottom - fabHeight - PANEL_GAP - SAFE_TOP;
    guide.style.setProperty("--ai-panel-max", `${Math.max(available, MIN_PANEL_HEIGHT)}px`);
  };
  const requestUpdate = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  readBase();
  requestUpdate();
  window.addEventListener("scroll", requestUpdate, { passive: true });
  window.addEventListener("resize", () => {
    readBase();
    requestUpdate();
  });
}

/** Optional hero parallax/scale via the Motion library — pure enhancement. */
export function enhanceHeroWithMotion() {
  if (prefersReduced()) return;
  const hero = document.querySelector(".hero");
  const img = document.querySelector(".hero-img");
  if (!hero || !img) return;
  import("https://cdn.jsdelivr.net/npm/motion@11.11.13/+esm")
    .then(({ animate, scroll }) => {
      scroll(animate(img, { transform: ["scale(1.0)", "scale(1.0)"] }, { easing: "linear" }), {
        target: hero,
      });
    })
    .catch(() => {
      /* Motion CDN unavailable — the hero still renders and scales via CSS, just without the scroll-linked easing. */
    });
}
