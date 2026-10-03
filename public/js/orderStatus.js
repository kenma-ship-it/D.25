import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, trapFocus, announce, setBackgroundInert } from "./utils.js";
import { payForOrder } from "./payment.js";

export const STATUS_LABELS = [
  ["ORDER_PLACED", "Order Placed"],
  ["PAYMENT_CONFIRMED", "Payment Confirmed"],
  ["PREPARING", "Preparing"],
  ["READY_FOR_DELIVERY", "Ready for Delivery"],
  ["OUT_FOR_DELIVERY", "Out for Delivery"],
  ["DELIVERED", "Delivered"],
];

// Before an order enters the steps above: waiting for the payment gateway, or
// cancelled because payment never arrived (server/payments/service.js).
const PRE_PAYMENT_LABELS = { AWAITING_PAYMENT: "Awaiting payment", CANCELLED: "Cancelled — not paid" };

/** Human-readable label for a status key — shared with myOrders.js's order-list badges. */
export function statusLabel(status) {
  if (PRE_PAYMENT_LABELS[status]) return PRE_PAYMENT_LABELS[status];
  const entry = STATUS_LABELS.find(([key]) => key === status);
  return entry ? entry[1] : status;
}

let currentOrder = null;
let paying = false;
let confirmingSince = 0; // set when the gateway took the money but the server hasn't confirmed yet

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

/** The payment box under the order reference — created on first use so every page's overlay markup can stay as it is. */
function paymentPanel() {
  let el = qs("#order-payment");
  if (!el) {
    el = document.createElement("div");
    el.id = "order-payment";
    el.className = "order-payment";
    el.setAttribute("aria-live", "polite");
    qs("#order-token").insertAdjacentElement("afterend", el);
  }
  return el;
}

function setTitle(text, done) {
  qs("#order-title").innerHTML = `${done ? '<svg class="icon icon-lg" aria-hidden="true"><use href="#icon-check"/></svg> ' : ""}${escapeHtml(text)}`;
}

function renderPayment(order) {
  const panel = paymentPanel();
  const p = order.payment;
  const tracker = qs("#status-tracker");
  if (!p) {
    // Orders placed before online payments existed.
    panel.hidden = true;
    tracker.hidden = false;
    setTitle("Order Placed", true);
    return;
  }
  const paid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status);
  tracker.hidden = !paid;
  panel.hidden = false;
  const amount = formatCurrency(p.amountPaise / 100);

  if (paid) {
    setTitle(p.status === "REFUNDED" ? "Payment refunded" : "Order confirmed", p.status !== "REFUNDED");
    panel.className = "order-payment is-paid";
    panel.innerHTML = `<p><strong>Paid ${amount}</strong>${p.method ? ` · ${escapeHtml(p.method.toUpperCase())}` : ""}</p>${
      p.paymentId ? `<p class="order-payment-ref">Payment ref: ${escapeHtml(p.paymentId)}</p>` : ""
    }${p.status === "REFUNDED" ? "<p>This payment has been refunded to you.</p>" : ""}`;
    confirmingSince = 0;
    return;
  }
  if (order.status === "CANCELLED") {
    setTitle("Order cancelled", false);
    panel.className = "order-payment is-problem";
    panel.innerHTML = `<p><strong>We didn't receive payment, so this order was cancelled.</strong></p>
      <p>You haven't been charged. If money was deducted from your account, it will be confirmed here automatically or refunded — message DE.25 with your order reference if you need help.</p>`;
    confirmingSince = 0;
    return;
  }
  // AWAITING_PAYMENT
  if (confirmingSince) {
    setTitle("Confirming your payment…", false);
    panel.className = "order-payment is-waiting";
    panel.innerHTML = `<p><strong>We're confirming your payment with the bank.</strong></p>
      <p>This usually takes a few seconds. Please don't pay again — this page updates by itself.</p>`;
    return;
  }
  const failed = p.status === "FAILED";
  setTitle(failed ? "Payment didn't go through" : "Complete your payment", false);
  panel.className = `order-payment ${failed ? "is-problem" : "is-waiting"}`;
  const until = p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  panel.innerHTML = `${
    failed
      ? `<p><strong>${escapeHtml(p.lastFailureReason || "Your payment failed.")}</strong></p><p>No money was taken for the failed attempt. You can try again${until ? ` until ${escapeHtml(until)}` : ""}.</p>`
      : `<p>Your order is saved. Pay <strong>${amount}</strong> online to confirm it${until ? ` (by ${escapeHtml(until)})` : ""}.</p>`
  }<button type="button" class="primary-btn" id="order-pay-btn">${failed ? "Try payment again" : `Pay ${amount}`}</button>`;
  qs("#order-pay-btn").addEventListener("click", () => startPayment(order.orderId));
}

/** (Re)opens the payment window for an unpaid order, then refreshes the order screen. */
export async function startPayment(orderId, checkout) {
  if (paying) return;
  paying = true;
  const btn = qs("#order-pay-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Opening payment…";
  }
  try {
    let params = checkout;
    if (!params) {
      const r = await api.startPayment(orderId);
      params = r.checkout;
    }
    const outcome = await payForOrder(orderId, params);
    if (outcome.result === "pending") confirmingSince = Date.now();
    const fresh = outcome.order || (await api.getOrder(orderId));
    paying = false;
    renderOrder(fresh);
  } catch (err) {
    paying = false;
    if (err.data && err.data.order) renderOrder(err.data.order);
    else if (currentOrder) renderOrder(currentOrder);
    const msg = document.createElement("p");
    msg.className = "field-error";
    msg.textContent = err.message;
    paymentPanel().appendChild(msg);
  } finally {
    paying = false;
  }
}

function renderOrder(order) {
  currentOrder = order;
  qs("#order-token").textContent = order.token || order.orderId.slice(0, 8).toUpperCase();
  const badge = qs("#order-delivery-badge");
  badge.textContent = order.isLiveDelivery ? "Live Borzo Delivery" : "Demo Delivery Estimate";
  renderTracker(order.status);
  renderPayment(order);

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
      if (paying) return; // don't redraw under an open payment window
      const before = currentOrder;
      const order = await api.getOrder(orderId);
      // Stop showing "confirming" once the server knows, or after 10 minutes (the
      // order then shows its real state; the dashboard keeps reconciling).
      if (confirmingSince && (order.status !== "AWAITING_PAYMENT" || Date.now() - confirmingSince > 10 * 60 * 1000)) confirmingSince = 0;
      renderOrder(order);
      if (!before || before.status !== order.status) announce(`Order status: ${statusLabel(order.status)}`);
      if (order.status === "DELIVERED" || order.status === "CANCELLED") stopPolling();
    } catch (_err) {
      // transient poll failures are not shown to the customer — the last known status stays visible
    }
  }, 5000);
}

/**
 * Shows the order screen. With `checkout` (straight after placing an order)
 * the payment window opens on top of it immediately.
 */
export function showOrderStatus(order, { checkout } = {}) {
  confirmingSince = 0;
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
  if (checkout) startPayment(order.orderId, checkout);
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
