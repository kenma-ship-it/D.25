import { initMenu } from "./menu.js";
import { initCart } from "./cart.js";
import { initCheckout } from "./checkout.js";
import { initProductDetail } from "./productDetail.js";
import { initOrderStatus } from "./orderStatus.js";
import { initAiGuide } from "./aiGuide.js";
import { initCustomEnquiry } from "./customEnquiry.js";
import { initMyOrders } from "./myOrders.js";
import { initMobileNav } from "./nav.js";
import { initGallerySlider } from "./gallerySlider.js";
import { initReveals, initHeaderOnDark, enhanceHeroWithMotion, initAiGuideFooterDock } from "./animations.js";
import { initCinematicMenu } from "./cinematicMenu.js";

/**
 * Single bootstrap entry point. Each init*() call wires exactly one
 * feature to the DOM and is independent of the others — if one throws,
 * the rest still run (see the try/catch below), so a bug in, say, the AI
 * guide never breaks the ability to browse the menu or check out.
 */
function boot() {
  const steps = [
    initCinematicMenu,
    initMenu,
    initCart,
    initCheckout,
    initProductDetail,
    initOrderStatus,
    initAiGuide,
    initCustomEnquiry,
    initMyOrders,
    initHeaderOnDark,
    initMobileNav,
    initGallerySlider,
    initAiGuideFooterDock,
  ];

  steps.forEach((step) => {
    try {
      step();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[DE.25] Failed to initialize ${step.name}:`, err);
    }
  });

  // Reveal animations run after the interactive features are wired so the
  // menu grid (rendered async by initMenu) still gets its reveal observers
  // attached via observeNewReveals() inside menu.js itself; this call
  // handles every other [data-reveal] element already present in the DOM.
  initReveals();
  enhanceHeroWithMotion();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
