export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

export function formatCurrency(rupees) {
  const n = Number(rupees) || 0;
  return "₹" + n.toLocaleString("en-IN");
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function announce(message) {
  const el = document.getElementById("a11y-announcer");
  if (el) el.textContent = message;
}

let toastTimer = null;
export function showToast(message, { isError = false } = {}) {
  const region = document.getElementById("toast-region");
  if (!region) return;
  region.innerHTML = "";
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " toast-error" : "");
  el.setAttribute("role", isError ? "alert" : "status");
  el.textContent = message;
  region.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (region.contains(el)) region.removeChild(el);
  }, 5000);
}

/**
 * Hides the rest of the page from assistive tech while a modal overlay is
 * open. The focus trap (below) already stops Tab from reaching background
 * content, but a screen reader's own virtual cursor doesn't respect that —
 * only `inert`/`aria-hidden` on the background regions does.
 */
export function setBackgroundInert(hidden) {
  qsa("#site-header, main#main, .site-footer").forEach((el) => {
    if (hidden) {
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    } else {
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    }
  });
}

/** Traps focus within `container` while `active` is true. Returns a cleanup function. */
export function trapFocus(container) {
  function handleKeydown(e) {
    if (e.key !== "Tab") return;
    const focusable = qsa(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      container
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  container.addEventListener("keydown", handleKeydown);
  return () => container.removeEventListener("keydown", handleKeydown);
}
