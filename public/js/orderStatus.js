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

// Statuses outside the kitchen's progression (server/orders/statuses.js):
// an order waits in AWAITING_PAYMENT until paid, and is CANCELLED if it
// never is. The tracker only draws STATUS_LABELS.
const PAYMENT_STATUS_LABELS = { AWAITING_PAYMENT: "Awaiting Payment", CANCELLED: "Cancelled" };

/** Human-readable label for a status key — shared with myOrders.js's order-list badges. */
export function statusLabel(status) {
  if (PAYMENT_STATUS_LABELS[status]) return PAYMENT_STATUS_LABELS[status];
  const entry = STATUS_LABELS.find(([key]) => key === status);
  return entry ? entry[1] : status;
}

let releaseFocusTrap = null;
let lastFocusedEl = null;
let pollTimer = null;

function renderTracker(currentStatus) {
  const tracker = qs("#status-tracker");
  tracker.hidden = currentStatus === "CANCELLED";
  // An unpaid order is placed but not yet at "Payment Confirmed".
  const shownStatus = currentStatus === "AWAITING_PAYMENT" ? "ORDER_PLACED" : currentStatus;
  const currentIndex = STATUS_LABELS.findIndex(([key]) => key === shownStatus);
  tracker.innerHTML = STATUS_LABELS.map(([key, label], i) => {
    const cls = i < currentIndex ? "is-done" : i === currentIndex ? "is-current" : "";
    return `<li class="${cls}">${escapeHtml(label)}</li>`;
  }).join("");
}

/** Only ever link to Borzo's own https tracking pages. */
function safeTrackingUrl(url) {
  return typeof url === "string" && /^https:\/\/(?:[a-z0-9-]+\.)*borzodelivery\.com\//i.test(url) ? url : null;
}

/** Who is delivering, from the courier booking on the order (see server/routes/order.js). */
function deliveryBadgeMarkup(order) {
  const d = order.delivery;
  if (order.status === "AWAITING_PAYMENT") return escapeHtml("A courier is booked once payment is confirmed");
  if (order.status === "CANCELLED") return escapeHtml("No courier booked");
  if (!d) return escapeHtml(order.isLiveDelivery ? "Booking a Borzo courier…" : "Demo Delivery Estimate");
  if (d.status === "failed") return escapeHtml("DE.25 is arranging delivery directly");
  if (d.provider !== "borzo") return escapeHtml("Demo Delivery Estimate");
  const label = d.environment === "test" ? "Borzo sandbox test booking" : "Borzo delivery";
  const parts = [label, d.statusLabel, d.courierName].filter(Boolean).map(escapeHtml);
  const tracking = safeTrackingUrl(d.trackingUrl);
  return parts.join(" · ") + (tracking ? ` · <a href="${escapeHtml(tracking)}" target="_blank" rel="noopener noreferrer">Track ↗</a>` : "");
}

function clockTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "";
}

/** Where the money stands, for an order that isn't moving through the kitchen yet. */
function paymentHint(order) {
  const p = order.payment || {};
  if (order.status === "AWAITING_PAYMENT") {
    return `This order isn't paid yet. It's cancelled automatically if payment isn't completed${p.expiresAt ? ` by ${clockTime(p.expiresAt)}` : ""}.`;
  }
  if (order.status === "CANCELLED") {
    if (p.status === "failed") return "The payment couldn't be started, so this order was cancelled. Nothing was charged.";
    return "This order was cancelled because payment wasn't completed in time.";
  }
  return null;
}

/** How a paid order was paid, when no real money moved. */
function paymentNote(order) {
  const p = order.payment;
  if (!p) return "";
  if (p.simulated) return "Payment was simulated (demo mode) — no money moved. ";
  if (p.method === "razorpay" && p.mode === "test") return "Paid in Razorpay test mode — no real money moved. ";
  return "";
}

/** What drives the status tracker for this order — never claims a real courier that isn't there. */
function statusHint(order) {
  const unpaid = paymentHint(order);
  if (unpaid) return unpaid;
  return paymentNote(order) + deliveryHint(order);
}

function deliveryHint(order) {
  const d = order.delivery;
  if (d && d.provider === "borzo" && d.status !== "failed") {
    return d.environment === "test"
      ? "Courier status comes from Borzo's sandbox — a real Borzo booking, but no rider is dispatched for test orders."
      : "Courier status updates automatically from Borzo as the rider picks up and delivers.";
  }
  return "This demo re-checks status every few seconds to simulate progress. In production this would update from real kitchen/courier events.";
}

const TITLES = { AWAITING_PAYMENT: "Awaiting Payment", CANCELLED: "Order Cancelled" };

function renderTitle(order) {
  const text = TITLES[order.status] || "Order Placed";
  const textEl = qs("#order-title-text");
  if (textEl) textEl.textContent = text;
  const icon = qs("#order-title svg");
  if (icon) icon.style.display = TITLES[order.status] ? "none" : "";
}

function renderOrder(order) {
  renderTitle(order);
  qs("#order-token").textContent = order.token || order.orderId.slice(0, 8).toUpperCase();
  qs("#order-delivery-badge").innerHTML = deliveryBadgeMarkup(order);
  const hint = qs("#order-status-hint");
  if (hint) hint.textContent = statusHint(order);
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
      announce(`Order status: ${statusLabel(order.status)}`);
      if (order.status === "DELIVERED" || order.status === "CANCELLED") stopPolling();
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
  if (order.status !== "DELIVERED" && order.status !== "CANCELLED") startPolling(order.orderId);
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
