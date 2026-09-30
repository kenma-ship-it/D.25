import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, trapFocus, announce, setBackgroundInert } from "./utils.js";

export const STATUS_LABELS = [
  ["ORDER_PLACED", "Order Placed"],
  ["PAYMENT_CONFIRMED", "Payment Confirmed"],
  ["PREPARING", "Preparing"],
  ["READY_FOR_DELIVERY", "Ready for Delivery"],
  ["OUT_FOR_DELIVERY", "Out for Delivery"],
  ["DELIVERED", "Delivered"],
];

/** Human-readable label for a status key — shared with myOrders.js's order-list badges. */
export function statusLabel(status) {
  const entry = STATUS_LABELS.find(([key]) => key === status);
  return entry ? entry[1] : status;
}

let releaseFocusTrap = null;
let lastFocusedEl = null;
let pollTimer = null;

function renderTracker(currentStatus) {
  const currentIndex = STATUS_LABELS.findIndex(([key]) => key === currentStatus);
  const tracker = qs("#status-tracker");
  tracker.innerHTML = STATUS_LABELS.map(([key, label], i) => {
    const cls = i < currentIndex ? "is-done" : i === currentIndex ? "is-current" : "";
    return `<li class="${cls}">${escapeHtml(label)}</li>`;
  }).join("");
}

function renderOrder(order) {
  qs("#order-token").textContent = order.token || order.orderId.slice(0, 8).toUpperCase();
  const badge = qs("#order-delivery-badge");
  badge.textContent = order.isLiveDelivery ? "Live Borzo Delivery" : "Demo Delivery Estimate";
  renderTracker(order.status);

  qs("#order-lines").innerHTML = order.lines
    .map(
      (l) =>
        `<div class="cart-line" style="grid-template-columns:1fr auto;"><span>${l.qty} × ${escapeHtml(l.name)}${
          l.variantLabel ? ` (${escapeHtml(l.variantLabel)})` : ""
        }</span><span>${formatCurrency(l.lineTotal)}</span></div>`
    )
    .join("");
  qs("#order-total").textContent = formatCurrency(order.total);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling(orderId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const order = await api.getOrder(orderId);
      renderOrder(order);
      announce(`Order status: ${STATUS_LABELS.find(([k]) => k === order.status)?.[1] || order.status}`);
      if (order.status === "DELIVERED") stopPolling();
    } catch (_err) {
      // transient poll failures are not shown to the customer — the last known status stays visible
    }
  }, 5000);
}

export function showOrderStatus(order) {
  renderOrder(order);
  const overlay = qs("#order-overlay");
  lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  releaseFocusTrap = trapFocus(overlay);
  qs("#close-order-btn").focus();
  startPolling(order.orderId);
}

function closeOrderStatus() {
  const overlay = qs("#order-overlay");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  stopPolling();
  if (releaseFocusTrap) releaseFocusTrap();
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
  if (lastFocusedEl) lastFocusedEl.focus();
}

export function initOrderStatus() {
  qs("#close-order-btn").addEventListener("click", closeOrderStatus);
}
