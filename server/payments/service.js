/**
 * Payment lifecycle for orders — the one place that decides what a payment
 * result means for an order. Every source of payment news (the customer's
 * browser after checkout, the gateway's webhook, the owner's "Check
 * payment" button, the background expiry check) goes through
 * applyGatewayPayment(), which is idempotent: the same payment reported
 * twice by different sources changes nothing the second time.
 *
 * order.payment = {
 *   provider, gatewayOrderId, amountPaise, currency, expiresAt,
 *   status: PENDING | FAILED | AUTHORIZED | PAID | EXPIRED | PARTIALLY_REFUNDED | REFUNDED,
 *   paymentId, method, vpa, bank, wallet, paidAt, amountPaidPaise,
 *   attempts: [{ paymentId, status, amountPaise, method, errorCode, errorReason, at, source }],
 *   refunds:  [{ refundId, paymentId, amountPaise, status, at }],
 *   issues:   [{ code, message, paymentId?, at, resolved }],
 *   lastCheckedAt
 * }
 *
 * Problems this handles (each becomes an `issue` the owner sees):
 *   - Paid, but the customer closed the page before we heard back
 *       -> the webhook or a reconcile confirms it anyway; no issue needed.
 *   - Payment failed -> attempt recorded with the gateway's reason; the
 *       order stays AWAITING_PAYMENT so the customer can retry; the kitchen
 *       is never told about it.
 *   - Never paid -> after PAYMENT_WINDOW_MINUTES the order is CANCELLED.
 *   - Paid after the order was cancelled for non-payment -> PAID_AFTER_EXPIRY:
 *       the order is reopened (the customer paid and expects food), and the
 *       owner is told to check with the customer.
 *   - Paid twice -> DUPLICATE_PAYMENT: refund the extra payment.
 *   - Amount differs from the order total -> AMOUNT_MISMATCH: NOT confirmed.
 *   - Money authorised but not captured -> AUTHORIZED_NOT_CAPTURED.
 *   - Refund failed at the gateway -> REFUND_FAILED.
 *   - Payment for an unknown order -> recorded in unmatchedStore.
 */
const { getOrder, getOrderByGatewayOrderId, updateOrder, setDeliveryOrderId, startDemoProgression } = require("../lib/orders");
const { getPaymentProvider } = require("./index");
const { recordUnmatched } = require("./unmatchedStore");

const RECONCILE_AFTER_MS = 2 * 60 * 1000; // give the customer's own callback / webhook a moment first
const RECONCILE_EVERY_MS = 60 * 1000;
const MAX_ATTEMPTS_KEPT = 25;

const ISSUE_TEXT = {
  PAID_AFTER_EXPIRY: "Customer paid after the order had expired. The order has been reopened — confirm with the customer that they still want it, or refund them.",
  DUPLICATE_PAYMENT: "Customer was charged more than once for this order. Refund the extra payment from the payment gateway dashboard.",
  AMOUNT_MISMATCH: "Amount paid doesn't match the order total, so the order was NOT confirmed. Check the payment in the gateway dashboard and refund or collect the difference.",
  AUTHORIZED_NOT_CAPTURED: "Money is authorised but not captured. Capture it in the gateway dashboard (or turn on auto-capture) — it is auto-refunded to the customer if left uncaptured.",
  REFUND_FAILED: "A refund failed at the payment gateway. Retry it from the gateway dashboard.",
  GATEWAY_ORDER_MISMATCH: "A payment arrived for this order under a different gateway order id. Check it in the gateway dashboard.",
};

function paymentWindowMs() {
  const mins = Number(process.env.PAYMENT_WINDOW_MINUTES);
  return (Number.isFinite(mins) && mins >= 5 ? mins : 30) * 60 * 1000;
}

function toPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

// One operation at a time per order inside this process, so a webhook and
// the customer's own callback arriving together can't both "confirm" it.
const locks = new Map();
function withOrderLock(orderId, fn) {
  const prev = locks.get(orderId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(orderId, tail);
  tail.then(() => {
    if (locks.get(orderId) === tail) locks.delete(orderId);
  });
  return run;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function addIssue(payment, code, extra = {}) {
  payment.issues = payment.issues || [];
  const key = `${code}:${extra.paymentId || ""}`;
  if (payment.issues.some((i) => `${i.code}:${i.paymentId || ""}` === key)) return;
  payment.issues.push({ code, message: ISSUE_TEXT[code] || code, ...extra, at: new Date().toISOString(), resolved: false });
}

// --- side effects of a newly-confirmed payment (never block or fail the payment itself) ---
let sideEffects = null;
function onOrderPaid(order) {
  if (!sideEffects) {
    const { notifyNewOrder } = require("../notifications");
    const { getDeliveryProvider } = require("../delivery");
    sideEffects = { notifyNewOrder, getDeliveryProvider };
  }
  const delivery = sideEffects.getDeliveryProvider();
  delivery
    .createDeliveryOrder({ orderId: order.orderId, address: order.address, customer: order.customer })
    .then((d) => setDeliveryOrderId(order.orderId, d.deliveryOrderId))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[payments] delivery order creation failed (order still stands):", err.message);
    });
  sideEffects.notifyNewOrder(order, { customerPhoneVerified: Boolean(order.customer && order.customer.phoneVerified) });
  // Demo only: without real kitchen/courier events, walk a demo order through its steps.
  if (order.payment && order.payment.provider === "demo") startDemoProgression(order.orderId);
}

/** Creates the gateway-side payment for a freshly created order. Returns the checkout params for the browser. */
async function startPayment(order) {
  const provider = getPaymentProvider();
  const amountPaise = toPaise(order.total);
  const { gatewayOrderId, checkout } = await provider.createPayment(order, amountPaise);
  const now = Date.now();
  const payment = {
    provider: provider.name,
    gatewayOrderId,
    amountPaise,
    currency: "INR",
    status: "PENDING",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + paymentWindowMs()).toISOString(),
    paymentId: null,
    attempts: [],
    refunds: [],
    issues: [],
    lastCheckedAt: null,
  };
  const saved = await updateOrder(order.orderId, { payment });
  return { order: saved, checkout };
}

/** Checkout params to (re)open the payment window for an unpaid order. */
function checkoutParamsFor(order) {
  const p = order.payment;
  const provider = getPaymentProvider();
  if (!p || p.provider !== provider.name) return null;
  if (provider.name === "razorpay") {
    return {
      provider: "razorpay",
      keyId: provider.keyId,
      gatewayOrderId: p.gatewayOrderId,
      amountPaise: p.amountPaise,
      currency: p.currency,
      name: "DE.25 by Harshali",
      description: `Order ${order.token}`,
      prefill: { name: order.customer.name, contact: `+91${order.customer.phone}`, email: order.customer.email || undefined },
      notes: { orderId: order.orderId },
    };
  }
  return { provider: "demo", gatewayOrderId: p.gatewayOrderId, amountPaise: p.amountPaise, currency: p.currency };
}

/**
 * Applies one gateway payment result to its order. `orderIdHint` is used
 * when the caller already knows the order (customer callback); otherwise
 * the order is found by gateway order id.
 * Returns the updated order, or null when the payment matched no order.
 */
async function applyGatewayPayment(gp, source, orderIdHint) {
  if (!gp || !gp.paymentId) return null;
  let target = orderIdHint ? await getOrder(orderIdHint) : null;
  if (!target && gp.gatewayOrderId) target = await getOrderByGatewayOrderId(gp.gatewayOrderId);
  if (!target && gp.orderIdNote) target = await getOrder(gp.orderIdNote);
  if (!target || !target.payment) {
    if (gp.status === "paid" || gp.status === "authorized" || gp.status === "refunded") await recordUnmatched(gp, source);
    return null;
  }

  return withOrderLock(target.orderId, async () => {
    const order = await getOrder(target.orderId);
    const payment = clone(order.payment);
    let status;
    let becamePaid = false;

    if (gp.gatewayOrderId && gp.gatewayOrderId !== payment.gatewayOrderId) {
      addIssue(payment, "GATEWAY_ORDER_MISMATCH", { paymentId: gp.paymentId });
    }

    // Record / update the attempt (idempotent per paymentId).
    payment.attempts = payment.attempts || [];
    const attempt = payment.attempts.find((a) => a.paymentId === gp.paymentId);
    const fields = {
      paymentId: gp.paymentId,
      status: gp.status,
      amountPaise: gp.amountPaise,
      method: gp.method || null,
      errorCode: gp.errorCode || null,
      errorReason: gp.errorReason || null,
      at: gp.at || new Date().toISOString(),
      source,
    };
    if (attempt) {
      // A later, more final status wins (pending -> authorized -> paid / failed); "client" reports never override the gateway.
      if (source !== "client" || attempt.source === "client") Object.assign(attempt, fields, { source: attempt.source === "client" ? source : attempt.source });
    } else {
      payment.attempts.push(fields);
      if (payment.attempts.length > MAX_ATTEMPTS_KEPT) payment.attempts = payment.attempts.slice(-MAX_ATTEMPTS_KEPT);
    }

    const alreadyPaid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(payment.status);

    if ((gp.status === "paid" || gp.status === "refunded") && source !== "client") {
      if (gp.amountPaise !== payment.amountPaise) {
        addIssue(payment, "AMOUNT_MISMATCH", { paymentId: gp.paymentId, amountPaise: gp.amountPaise });
      } else if (alreadyPaid && payment.paymentId && payment.paymentId !== gp.paymentId) {
        addIssue(payment, "DUPLICATE_PAYMENT", { paymentId: gp.paymentId, amountPaise: gp.amountPaise });
      } else if (!alreadyPaid) {
        Object.assign(payment, {
          status: "PAID",
          paymentId: gp.paymentId,
          method: gp.method || null,
          vpa: gp.vpa || null,
          bank: gp.bank || null,
          wallet: gp.wallet || null,
          amountPaidPaise: gp.amountPaise,
          paidAt: gp.at || new Date().toISOString(),
        });
        payment.issues = (payment.issues || []).filter((i) => i.code !== "AUTHORIZED_NOT_CAPTURED");
        if (order.status === "CANCELLED") addIssue(payment, "PAID_AFTER_EXPIRY", { paymentId: gp.paymentId });
        status = "PAYMENT_CONFIRMED";
        becamePaid = true;
      }
    } else if (gp.status === "authorized" && source !== "client" && !alreadyPaid) {
      payment.status = "AUTHORIZED";
      addIssue(payment, "AUTHORIZED_NOT_CAPTURED", { paymentId: gp.paymentId });
    } else if (gp.status === "failed" && !alreadyPaid && payment.status !== "EXPIRED") {
      payment.status = "FAILED";
    }

    const saved = await updateOrder(order.orderId, { payment, status });
    if (becamePaid) onOrderPaid(saved);
    return saved;
  });
}

/** Applies a refund webhook. */
async function applyRefund(refund, gp) {
  let order = gp && gp.gatewayOrderId ? await getOrderByGatewayOrderId(gp.gatewayOrderId) : null;
  if (!order && gp && gp.orderIdNote) order = await getOrder(gp.orderIdNote);
  if (!order || !order.payment) return null;
  return withOrderLock(order.orderId, async () => {
    const fresh = await getOrder(order.orderId);
    const payment = clone(fresh.payment);
    payment.refunds = payment.refunds || [];
    const existing = payment.refunds.find((r) => r.refundId === refund.refundId);
    if (existing) Object.assign(existing, refund);
    else payment.refunds.push({ ...refund });
    if (refund.status === "failed") addIssue(payment, "REFUND_FAILED", { paymentId: refund.paymentId });

    // Refund of the main payment changes the order's payment status; a
    // refund of a duplicate charge resolves that duplicate's issue instead.
    const refundedForMain = payment.refunds
      .filter((r) => r.status === "processed" && r.paymentId === payment.paymentId)
      .reduce((sum, r) => sum + r.amountPaise, 0);
    if (refundedForMain > 0) payment.status = refundedForMain >= (payment.amountPaidPaise || payment.amountPaise) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    if (refund.status === "processed" && refund.paymentId !== payment.paymentId) {
      for (const i of payment.issues || []) if (i.code === "DUPLICATE_PAYMENT" && i.paymentId === refund.paymentId) i.resolved = true;
    }
    return updateOrder(fresh.orderId, { payment });
  });
}

/** Asks the gateway for every payment on this order and applies them (the "Check payment" button). */
async function reconcileOrder(orderId, source = "reconcile") {
  const order = await getOrder(orderId);
  if (!order || !order.payment) return order;
  const provider = getPaymentProvider();
  let latest = order;
  if (provider.name === order.payment.provider && provider.isLive) {
    const payments = await provider.listOrderPayments(order.payment.gatewayOrderId);
    for (const gp of payments) latest = (await applyGatewayPayment(gp, source, orderId)) || latest;
  }
  return withOrderLock(orderId, async () => {
    const fresh = await getOrder(orderId);
    const payment = clone(fresh.payment);
    payment.lastCheckedAt = new Date().toISOString();
    return updateOrder(orderId, { payment });
  });
}

/** Cancels an order whose payment window has passed with no payment (checking the gateway first). */
async function expireIfStale(order, now = Date.now()) {
  if (!order || order.status !== "AWAITING_PAYMENT" || !order.payment) return order;
  if (new Date(order.payment.expiresAt).getTime() > now) return order;
  let current = order;
  try {
    current = (await reconcileOrder(order.orderId, "expiry-check")) || order;
  } catch (err) {
    // Gateway unreachable — don't cancel on a guess; try again next time.
    // eslint-disable-next-line no-console
    console.error(`[payments] could not check ${order.orderId} with the gateway before expiry:`, err.message);
    return order;
  }
  if (current.status !== "AWAITING_PAYMENT") return current;
  return withOrderLock(order.orderId, async () => {
    const fresh = await getOrder(order.orderId);
    if (fresh.status !== "AWAITING_PAYMENT") return fresh;
    const payment = clone(fresh.payment);
    payment.status = "EXPIRED";
    return updateOrder(fresh.orderId, { payment, status: "CANCELLED" });
  });
}

/**
 * Called on dashboard refreshes and customer status polls (works on
 * serverless — no background timers needed): expires stale orders and,
 * for a live gateway, re-checks unpaid ones that are a couple of minutes old.
 */
async function sweep(orders, { maxChecks = 5, now = Date.now() } = {}) {
  const provider = getPaymentProvider();
  let checks = 0;
  const out = [];
  for (const order of orders) {
    let o = order;
    try {
      if (o.status === "AWAITING_PAYMENT" && o.payment) {
        if (new Date(o.payment.expiresAt).getTime() <= now) {
          o = await expireIfStale(o, now);
        } else if (
          provider.isLive &&
          checks < maxChecks &&
          now - new Date(o.payment.createdAt || o.createdAt).getTime() > RECONCILE_AFTER_MS &&
          (!o.payment.lastCheckedAt || now - new Date(o.payment.lastCheckedAt).getTime() > RECONCILE_EVERY_MS)
        ) {
          checks += 1;
          o = (await reconcileOrder(o.orderId)) || o;
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[payments] sweep failed for ${o.orderId}:`, err.message);
    }
    out.push(o);
  }
  return out;
}

/** Owner marks a flagged issue as dealt with. */
async function resolveIssue(orderId, code, paymentId) {
  return withOrderLock(orderId, async () => {
    const order = await getOrder(orderId);
    if (!order || !order.payment) return null;
    const payment = clone(order.payment);
    let found = false;
    for (const i of payment.issues || []) {
      if (i.code === code && (i.paymentId || "") === (paymentId || "") && !i.resolved) {
        i.resolved = true;
        i.resolvedAt = new Date().toISOString();
        found = true;
      }
    }
    if (!found) return order;
    return updateOrder(orderId, { payment });
  });
}

/** What the customer may see about their payment (no gateway ids beyond what's needed). */
function customerPaymentSummary(order) {
  const p = order.payment;
  if (!p) return null;
  const lastFailure = [...(p.attempts || [])].reverse().find((a) => a.status === "failed");
  return {
    status: p.status,
    provider: p.provider,
    amountPaise: p.amountPaise,
    expiresAt: p.expiresAt,
    canPay: order.status === "AWAITING_PAYMENT",
    lastFailureReason: p.status === "FAILED" && lastFailure ? lastFailure.errorReason || "Payment didn't go through." : null,
    paymentId: p.paymentId || null,
    method: p.method || null,
  };
}

module.exports = {
  startPayment,
  checkoutParamsFor,
  applyGatewayPayment,
  applyRefund,
  reconcileOrder,
  expireIfStale,
  sweep,
  resolveIssue,
  customerPaymentSummary,
  ISSUE_TEXT,
  toPaise,
};
