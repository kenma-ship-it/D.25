import { api } from "./api.js";
import { qs, trapFocus, setBackgroundInert } from "./utils.js";

let releaseFocusTrap = null;
let lastFocusedEl = null;

function setError(message) {
  const el = qs("#custom-form-error");
  el.textContent = message || "";
  el.hidden = !message;
}

function validatePhone(value) {
  return /^\d{10}$/.test(value.trim());
}

async function handleSubmit() {
  setError("");

  const name = qs("#c-name").value.trim();
  const occasion = qs("#c-occasion").value.trim();
  const phone = qs("#c-phone").value.trim();

  if (!name) {
    setError("Please tell us your name.");
    qs("#c-name").focus();
    return;
  }
  if (!validatePhone(phone)) {
    setError("Please enter a 10-digit WhatsApp number so we can get back to you.");
    qs("#c-phone").focus();
    return;
  }
  if (!occasion) {
    setError("Please tell us the occasion for the cake.");
    qs("#c-occasion").focus();
    return;
  }
  const payload = {
    name,
    occasion,
    preferredDate: qs("#c-date").value,
    size: qs("#c-size").value.trim(),
    flavor: qs("#c-flavor").value.trim(),
    message: qs("#c-message").value.trim(),
    phone,
    budget: qs("#c-budget").value.trim(),
  };

  const submitBtn = qs("#submit-custom-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending…";

  try {
    await api.submitCustomEnquiry(payload);
    qs("#custom-form-wrap").hidden = true;
    qs("#custom-confirm").hidden = false;
    qs("#custom-done-btn").focus();
  } catch (err) {
    setError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send enquiry";
  }
}

function resetForm() {
  ["c-name", "c-occasion", "c-date", "c-size", "c-flavor", "c-message", "c-phone", "c-budget"].forEach((id) => {
    qs(`#${id}`).value = "";
  });
  // No past dates (local calendar day, not UTC).
  const now = new Date();
  qs("#c-date").min = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  setError("");
  qs("#custom-form-wrap").hidden = false;
  qs("#custom-confirm").hidden = true;
}

export function openCustomEnquiry() {
  resetForm();
  const overlay = qs("#custom-overlay");
  lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  releaseFocusTrap = trapFocus(overlay);
  qs("#c-name").focus();
}

export function closeCustomEnquiry() {
  const overlay = qs("#custom-overlay");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  if (releaseFocusTrap) releaseFocusTrap();
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
  if (lastFocusedEl) lastFocusedEl.focus();
}

export function initCustomEnquiry() {
  // Not every page offers a custom-cake CTA (e.g. savouries.html, sips.html
  // deliberately have no custom-band section), so this feature no-ops
  // gracefully instead of throwing when its trigger button isn't present.
  const openBtn = document.getElementById("open-custom-btn");
  if (!openBtn) return;
  openBtn.addEventListener("click", openCustomEnquiry);
  qs("#close-custom").addEventListener("click", closeCustomEnquiry);
  qs("#custom-done-btn").addEventListener("click", closeCustomEnquiry);
  qs("#custom-overlay").addEventListener("click", (e) => {
    if (e.target.id === "custom-overlay") closeCustomEnquiry();
  });
  qs("#submit-custom-btn").addEventListener("click", handleSubmit);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !qs("#custom-overlay").hidden) closeCustomEnquiry();
  });
}
