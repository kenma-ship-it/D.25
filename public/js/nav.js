/**
 * Mobile primary navigation.
 *
 * Below 760px the .main-nav link row is replaced (via CSS, see styles.css)
 * with a hamburger-triggered dropdown anchored to the sticky header. This
 * module wires the toggle button, closes the dropdown on link click,
 * outside click, Escape, and on resize back to desktop width.
 *
 * Above 760px #nav-toggle is display:none, so a click on it can never fire
 * and this module is effectively inert there — no desktop behaviour changes.
 */
export function initMobileNav() {
  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("main-nav");
  const scrim = document.getElementById("nav-scrim");
  if (!toggle || !nav) return;

  const closeNav = () => {
    nav.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    if (scrim) scrim.classList.remove("is-open");
  };
  const openNav = () => {
    nav.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
    if (scrim) scrim.classList.add("is-open");
  };

  toggle.addEventListener("click", () => {
    if (nav.classList.contains("is-open")) closeNav();
    else openNav();
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeNav);
  });

  document.addEventListener("click", (event) => {
    if (!nav.classList.contains("is-open")) return;
    if (nav.contains(event.target) || toggle.contains(event.target)) return;
    closeNav();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      closeNav();
      toggle.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 760) closeNav();
  });
}
