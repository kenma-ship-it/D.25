/**
 * "My Orders" — lets a returning customer, with no account or login in
 * this demo, see their past orders and the live status of anything still
 * in progress by typing the phone number they checked out with. Reuses
 * the existing single-order status overlay/tracker (orderStatus.js) to
 * show live status once an order is picked from the list, exactly the
 * way productDetail.js hands off to the AI guide: close this drawer
 * first, then open the next thing, so only one overlay is ever active.
 */
import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, qsa, trapFocus, setBackgroundInert } from "./utils.js";
import { showOrderStatus, statusLabel } from "./orderStatus.js";
import { createPhoneVerifier } from "./phoneVerify.js";

let releaseFocusTrap = null;
let lastFocusedEl = null;
let lastResults = [];
let verifier = null;

function summaryLine(order) {
  return (order.lines || []).map((l) => `${l.qty} × ${l.name}`).join(", ");
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch (_err) {
    return "";
  }
}

function renderResults(orders) {
  lastResults = orders;
  const wrap = qs("#myorders-results");

  if (orders.length === 0) {
    wrap.innerHTML = `<p class="empty-state">No orders found for that number. Double-check the phone number you used at checkout.</p>`;
    return;
  }

  wrap.innerHTML = `<div class="myorders-list">${orders
    .map((order, i) => {
      const isDone = order.status === "DELIVERED" || order.status === "CANCELLED";
      return `
        <button type="button" class="myorders-item" data-index="${i}">
          <div class="myorders-item-head">
            <span class="myorders-token">${escapeHtml(order.token || order.orderId.slice(0, 8).toUpperCase())}</span>
            <span class="myorders-status ${isDone ? "is-done" : "is-current"}">${escapeHtml(statusLabel(order.status))}</span>
          </div>
          <p class="myorders-summary">${escapeHtml(summaryLine(order))}</p>
          <div class="myorders-item-foot"><span>${escapeHtml(formatDate(order.createdAt))}</span><span>${formatCurrency(order.total)}</span></div>
        </button>`;
    })
    .join("")}</div>`;

  qsa(".myorders-item", wrap).forEach((btn) => {
    btn.addEventListener("click", () => {
      const order = lastResults[Number(btn.dataset.index)];
      if (!order) return;
      closeMyOrders();
      showOrderStatus(order);
    });
  });
}

/**
 * One button, three steps: send the WhatsApp code -> verify it -> show
 * orders. If this number was already verified during this visit (e.g. at
 * checkout), it skips straight to showing orders.
 */
function syncSubmitLabel() {
  const submitBtn = qs("#myorders-submit");
  if (verifier.isVerified()) submitBtn.textContent = "Show my orders";
  else if (verifier.isCodeStep()) submitBtn.textContent = "Verify and show orders";
  else submitBtn.textContent = "Send code on WhatsApp";
  qs("#myorders-send").hidden = !verifier.isCodeStep() || verifier.isVerified();
}

async function fetchOrders(phone) {
  const errorEl = qs("#myorders-error");
  qs("#myorders-results").innerHTML = "";
  try {
    const { orders } = await api.getOrdersByPhone(phone, verifier.getToken());
    renderResults(orders);
  } catch (err) {
    if (err.data && err.data.needsVerification) {
      verifier.reset();
      syncSubmitLabel();
    }
    errorEl.textContent = err.message || "Something went wrong. Please try again.";
    errorEl.hidden = false;
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  const input = qs("#myorders-phone");
  const errorEl = qs("#myorders-error");
  const submitBtn = qs("#myorders-submit");
  const phone = input.value.replace(/\D/g, "");
  errorEl.hidden = true;

  if (!/^\d{10}$/.test(phone)) {
    errorEl.textContent = "Please enter the 10-digit WhatsApp number you ordered with.";
    errorEl.hidden = false;
    input.focus();
    return;
  }

  submitBtn.disabled = true;
  try {
    if (verifier.isVerified()) {
      submitBtn.textContent = "Loading…";
      await fetchOrders(phone);
    } else if (verifier.isCodeStep()) {
      submitBtn.textContent = "Checking…";
      if (await verifier.confirm()) await fetchOrders(phone);
    } else {
      submitBtn.textContent = "Sending…";
      await verifier.send();
    }
  } finally {
    submitBtn.disabled = false;
    syncSubmitLabel();
  }
}

export function openMyOrders() {
  const overlay = qs("#myorders-drawer");
  lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  releaseFocusTrap = trapFocus(overlay);
  if (verifier) {
    verifier.refresh();
    syncSubmitLabel();
  }
  qs("#myorders-phone").focus();
}

export function closeMyOrders() {
  const overlay = qs("#myorders-drawer");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  if (releaseFocusTrap) releaseFocusTrap();
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
  if (lastFocusedEl) lastFocusedEl.focus();
}

export function initMyOrders() {
  const openBtn = document.getElementById("open-myorders-btn");
  const overlay = document.getElementById("myorders-drawer");
  if (!openBtn || !overlay) return;

  openBtn.addEventListener("click", openMyOrders);
  qs("#close-myorders").addEventListener("click", closeMyOrders);
  overlay.addEventListener("click", (e) => {
    if (e.target.id === "myorders-drawer") closeMyOrders();
  });
  verifier = createPhoneVerifier(
    {
      phoneInput: qs("#myorders-phone"),
      sendBtn: qs("#myorders-send"),
      codeWrap: qs("#myorders-code-wrap"),
      codeInput: qs("#myorders-code"),
      confirmBtn: qs("#myorders-confirm"),
      statusEl: qs("#myorders-status"),
      errorEl: qs("#myorders-error"),
    },
    { onVerified: syncSubmitLabel, onReset: syncSubmitLabel, enterConfirms: false }
  );
  qs("#myorders-phone").addEventListener("input", syncSubmitLabel);
  qs("#myorders-send").addEventListener("click", () => setTimeout(syncSubmitLabel, 0));
  // Enter inside the code box should submit the form (verify + show), not
  // just the hidden confirm button the shared widget listens on.
  qs("#myorders-form").addEventListener("submit", handleSubmit);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeMyOrders();
  });
}
