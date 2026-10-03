/**
 * Payments: the only way an order leaves AWAITING_PAYMENT.
 *
 *   checkout -> order stored as AWAITING_PAYMENT with order.payment =
 *               { method, status: "pending", amountPaise, expiresAt, … }
 *            -> startPayment() hands the browser what it needs to pay
 *   paid     -> completePayment(): status PAYMENT_CONFIRMED, then (and only
 *               then) the courier is booked and the owner/customer notified
 *               (lib/placeOrder.js dispatchPaidOrder)
 *   unpaid   -> expireStalePayments() cancels it after the payment window
 *
 * How "paid" is proven depends on the method (see paymentConfig.js):
 *   razorpay  Razorpay's signature over order_id|payment_id (checked with
 *             the key secret), or a signed webhook, or Razorpay's API when
 *             reconciling — never the browser's word alone. Nobody presses
 *             a button: whichever of the three arrives first confirms it,
 *             and reconcilePendingPayments() asks Razorpay every few
 *             seconds so a payment shows up even with no webhook (localhost)
 *             and the customer's tab closed.
 *   demo      Nobody — it's simulated, labelled as such everywhere, and
 *             impossible in production.
 *
 * completePayment() is a compare-and-set on the order status, so a checkout
 * callback and a webhook arriving together still book exactly one courier.
 */
const { resolvePaymentConfig } = require("./paymentConfig");
const { RazorpayClient, verifyCheckoutSignature, verifyWebhookSignature } = require("./RazorpayClient");
const { getOrder, getAllOrders, setPayment } = require("../lib/orders");
const { AWAITING_PAYMENT, CANCELLED } = require("../orders/statuses");
const { dispatchPaidOrder } = require("../lib/placeOrder");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class PaymentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "PaymentError";
    this.statusCode = statusCode;
  }
}

let razorpayClientOverride = null;
function getRazorpayClient(cfg) {
  if (razorpayClientOverride) return razorpayClientOverride;
  return new RazorpayClient({ keyId: cfg.razorpay.keyId, keySecret: cfg.razorpay.keySecret });
}
/** Test-only: route Razorpay calls to a stub (null restores the real client). */
function _setRazorpayClientForTests(client) {
  razorpayClientOverride = client;
}

function nowIso() {
  return new Date().toISOString();
}

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[payments] ${message}`);
}

/** Customer-safe view of order.payment — no gateway internals. */
function publicPayment(p) {
  if (!p) return null;
  return {
    method: p.method,
    status: p.status,
    mode: p.mode || null,
    simulated: Boolean(p.simulated),
    expiresAt: p.expiresAt || null,
    paidAt: p.paidAt || null,
    lastError: p.lastError ? p.lastError.description || null : null,
  };
}

/**
 * What the browser needs to collect payment for a freshly stored order.
 * For Razorpay this creates the gateway order (amount fixed here, never by
 * the browser); if that fails the order is cancelled, not left dangling.
 */
async function startPayment(order, cfg = resolvePaymentConfig()) {
  const p = order.payment;
  const base = { method: p.method, amountPaise: p.amountPaise, amountRupees: order.total, expiresAt: p.expiresAt };

  if (p.method === "razorpay") {
    let gatewayOrder;
    try {
      gatewayOrder = await getRazorpayClient(cfg).createOrder({
        amountPaise: p.amountPaise,
        receipt: `DE25-${order.token}-${order.orderId.slice(0, 8)}`,
        notes: { de25_order_id: order.orderId, de25_token: order.token },
      });
      if (!gatewayOrder || !gatewayOrder.id || gatewayOrder.amount !== p.amountPaise) {
        throw new Error("Razorpay returned an unexpected order");
      }
    } catch (err) {
      log(`Razorpay order creation failed for ${order.token}: ${err.message}`);
      await setPayment(order.orderId, { ...p, status: "failed", failedAt: nowIso(), lastError: { description: err.message } }, { status: CANCELLED, onlyIfStatus: AWAITING_PAYMENT });
      throw new PaymentError(err.publicMessage || "The payment gateway is unavailable right now. Please try again in a minute.", 502);
    }
    await setPayment(order.orderId, { ...p, gatewayOrderId: gatewayOrder.id, mode: cfg.razorpay.mode }, { onlyIfStatus: AWAITING_PAYMENT });
    log(`Razorpay ${cfg.razorpay.mode} order ${gatewayOrder.id} created for ${order.token} (Rs ${order.total})`);
    return {
      ...base,
      keyId: cfg.razorpay.keyId,
      gatewayOrderId: gatewayOrder.id,
      mode: cfg.razorpay.mode,
      currency: "INR",
      merchantName: "DE.25",
      description: `Order ${order.token}`,
      prefill: { name: order.customer.name, contact: order.customer.phone, email: order.customer.email || undefined },
      notes: { de25_order_id: order.orderId },
    };
  }

  return { ...base, simulated: true };
}

/**
 * Marks an order paid and dispatches it — exactly once. A late payment for
 * an order that only expired is honoured: the customer's money arrived, so
 * the order goes ahead.
 */
async function completePayment(orderId, details, { notify = true } = {}) {
  const order = await getOrder(orderId);
  if (!order || !order.payment) return null;
  const payment = { ...order.payment, ...details, status: "paid", paidAt: nowIso(), lastError: null };
  let from = AWAITING_PAYMENT;
  if (order.status === CANCELLED && order.payment.status === "expired") {
    from = CANCELLED;
    payment.paidAfterExpiry = true;
  }
  const updated = await setPayment(orderId, payment, { status: "PAYMENT_CONFIRMED", onlyIfStatus: from });
  if (!updated) return { order: await getOrder(orderId), alreadySettled: true, deliveryPromise: null };
  log(`order ${updated.token} paid — ${describeProof(payment)}`);
  const deliveryPromise = dispatchPaidOrder(updated, { notify });
  return { order: updated, alreadySettled: false, deliveryPromise };
}

function describeProof(p) {
  if (p.method === "razorpay") return `Razorpay ${p.mode || ""} ${p.paymentId || ""} (${p.verifiedBy})`.replace(/\s+/g, " ");
  return `${p.method} (simulated, no money moved)`;
}

async function requireOrder(orderId) {
  if (!UUID_PATTERN.test(String(orderId))) throw new PaymentError("Order not found.", 404);
  const order = await getOrder(orderId);
  if (!order || !order.payment) throw new PaymentError("Order not found.", 404);
  return order;
}

function settledResult(order) {
  if (order.payment.status === "paid") return { order, alreadySettled: true, deliveryPromise: null };
  throw new PaymentError("This order is no longer waiting for payment. Please place a new order.", 409);
}

// ------------------------------------------------------------- Razorpay ---

/** The browser's Razorpay success callback — trusted only after the HMAC checks out. */
async function verifyRazorpayCheckout(orderId, { razorpay_order_id: gatewayOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  const cfg = resolvePaymentConfig();
  const order = await requireOrder(orderId);
  const p = order.payment;
  if (p.method !== "razorpay") throw new PaymentError("This order isn't paid through Razorpay.", 409);
  if (!cfg.razorpay.configured) throw new PaymentError("Razorpay isn't configured on this server.", 503);
  if (!p.gatewayOrderId || gatewayOrderId !== p.gatewayOrderId) throw new PaymentError("This payment belongs to a different order.", 400);
  if (!verifyCheckoutSignature({ gatewayOrderId, paymentId, signature, keySecret: cfg.razorpay.keySecret })) {
    log(`rejected a Razorpay callback with a bad signature for ${order.token}`);
    throw new PaymentError("We couldn't verify this payment. If money left your account, it will be refunded automatically by Razorpay.", 400);
  }
  if (order.status !== AWAITING_PAYMENT && !(order.status === CANCELLED && p.status === "expired")) return settledResult(order);

  const result = await completePayment(orderId, { paymentId, verifiedBy: "razorpay-signature" });
  if (result && !result.alreadySettled) ensureCaptured(orderId, cfg).catch(() => {});
  return result;
}

/**
 * Accounts set to manual capture leave a payment "authorized" (and Razorpay
 * refunds it after a few days); capture it so the shop is actually paid.
 * Also cross-checks the amount and order against Razorpay's own record.
 */
async function ensureCaptured(orderId, cfg = resolvePaymentConfig()) {
  const order = await getOrder(orderId);
  if (!order || !order.payment || !order.payment.paymentId) return null;
  const p = order.payment;
  try {
    const client = getRazorpayClient(cfg);
    let payment = await client.fetchPayment(p.paymentId);
    const anomaly =
      payment.order_id !== p.gatewayOrderId ? "Razorpay payment belongs to a different gateway order" : payment.amount !== p.amountPaise ? `Razorpay amount ${payment.amount} paise != expected ${p.amountPaise}` : null;
    if (!anomaly && payment.status === "authorized") payment = await client.capturePayment(p.paymentId, p.amountPaise);
    const latest = await getOrder(orderId);
    await setPayment(orderId, { ...latest.payment, gatewayStatus: payment.status, gatewayMethod: payment.method || null, checkedAt: nowIso(), anomaly });
    if (anomaly) log(`ANOMALY on ${order.token}: ${anomaly}`);
    return payment.status;
  } catch (err) {
    log(`couldn't confirm capture for ${order.token}: ${err.message}`);
    return null;
  }
}

/**
 * Razorpay has no such order under these keys (made with other keys, e.g.
 * before switching test -> live) — it can never be paid here, so it isn't
 * "unreachable" either: waiting on it would keep it pending forever.
 */
function isUnknownToRazorpay(err) {
  return Boolean(err) && (err.httpStatus === 404 || (err.httpStatus === 400 && /does not exist/i.test(err.description || "")));
}

/** Asks Razorpay directly whether a pending order was paid (no webhook on localhost, closed tab, …). */
async function reconcileRazorpayOrder(order, cfg = resolvePaymentConfig()) {
  const p = order.payment;
  if (!p || p.method !== "razorpay" || !p.gatewayOrderId || !cfg.razorpay.configured) return null;
  let payments;
  try {
    payments = await getRazorpayClient(cfg).listOrderPayments(p.gatewayOrderId);
  } catch (err) {
    if (!isUnknownToRazorpay(err)) throw err;
    payments = [];
  }
  const paid = payments.find((x) => (x.status === "captured" || x.status === "authorized") && x.amount === p.amountPaise);
  if (!paid) {
    const failed = payments.find((x) => x.status === "failed");
    if (failed && (!p.lastError || p.lastError.paymentId !== failed.id)) {
      await setPayment(order.orderId, { ...p, lastError: { paymentId: failed.id, code: failed.error_code || null, description: failed.error_description || "Payment failed", at: nowIso() } }, { onlyIfStatus: AWAITING_PAYMENT });
    }
    return null;
  }
  const result = await completePayment(order.orderId, { paymentId: paid.id, verifiedBy: "razorpay-api", gatewayStatus: paid.status });
  if (result && !result.alreadySettled) ensureCaptured(order.orderId, cfg).catch(() => {});
  return result;
}

const lastRefresh = new Map();
/** Customer-triggered "I've paid — check again", at most once per 15 s per order. */
async function refreshRazorpayPayment(orderId) {
  const order = await requireOrder(orderId);
  if (order.payment.method !== "razorpay") throw new PaymentError("This order isn't paid through Razorpay.", 409);
  if (order.status !== AWAITING_PAYMENT) return { order };
  const last = lastRefresh.get(orderId) || 0;
  if (Date.now() - last < 15000) return { order };
  lastRefresh.set(orderId, Date.now());
  try {
    const result = await reconcileRazorpayOrder(order);
    return { order: result ? result.order : await getOrder(orderId) };
  } catch (err) {
    log(`refresh failed for ${order.token}: ${err.message}`);
    return { order };
  }
}

/**
 * Razorpay's server-to-server notice (Dashboard -> Webhooks, events
 * payment.captured / order.paid / payment.failed). Answers 2xx for anything
 * correctly signed — even events it ignores — so Razorpay stops retrying.
 */
async function handleRazorpayWebhook(rawBody, signature) {
  const cfg = resolvePaymentConfig();
  if (!cfg.razorpay.webhookSecret) return { status: 503, body: { error: "RAZORPAY_WEBHOOK_SECRET is not set on this server." } };
  if (!verifyWebhookSignature({ rawBody, signature, webhookSecret: cfg.razorpay.webhookSecret })) {
    log("rejected a webhook with a bad signature");
    return { status: 400, body: { error: "Bad signature." } };
  }
  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
  } catch (_e) {
    return { status: 400, body: { error: "Invalid JSON." } };
  }
  const payment = event.payload && event.payload.payment ? event.payload.payment.entity : null;
  const gatewayOrder = event.payload && event.payload.order ? event.payload.order.entity : null;
  const orderId = (payment && payment.notes && payment.notes.de25_order_id) || (gatewayOrder && gatewayOrder.notes && gatewayOrder.notes.de25_order_id);
  if (!orderId || !UUID_PATTERN.test(orderId)) return { status: 200, body: { ignored: "not a DE.25 order" } };
  const order = await getOrder(orderId);
  if (!order || !order.payment || order.payment.method !== "razorpay") return { status: 200, body: { ignored: "unknown order" } };
  const gatewayOrderId = (payment && payment.order_id) || (gatewayOrder && gatewayOrder.id);
  if (gatewayOrderId !== order.payment.gatewayOrderId) return { status: 200, body: { ignored: "gateway order mismatch" } };

  if ((event.event === "payment.captured" || event.event === "order.paid") && payment) {
    if (payment.amount !== order.payment.amountPaise) {
      log(`ANOMALY: webhook amount ${payment.amount} != ${order.payment.amountPaise} for ${order.token}`);
      return { status: 200, body: { ignored: "amount mismatch" } };
    }
    await completePayment(orderId, { paymentId: payment.id, verifiedBy: "razorpay-webhook", gatewayStatus: payment.status, gatewayMethod: payment.method || null });
    return { status: 200, body: { ok: true } };
  }
  if (event.event === "payment.failed" && payment && order.status === AWAITING_PAYMENT) {
    await setPayment(
      orderId,
      { ...order.payment, lastError: { paymentId: payment.id, code: payment.error_code || null, description: payment.error_description || "Payment failed", at: nowIso() } },
      { onlyIfStatus: AWAITING_PAYMENT }
    );
  }
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------- Demo ---

async function simulateDemoPayment(orderId) {
  const cfg = resolvePaymentConfig();
  const order = await requireOrder(orderId);
  if (order.payment.method !== "demo" || cfg.method !== "demo") throw new PaymentError("Simulated payments are only available in demo mode.", 403);
  if (order.status !== AWAITING_PAYMENT) return settledResult(order);
  return completePayment(orderId, { simulated: true, verifiedBy: "simulated" });
}

// ------------------------------------------------------ Sweeper/expiry ---

/**
 * Asks Razorpay about every Razorpay order still waiting for money, so a
 * payment confirms itself within seconds even when the browser callback
 * never arrived (tab closed, phone locked mid-QR) and no webhook can reach
 * this server (localhost). Orders past their window are left to
 * expireStalePayments(), which checks Razorpay once more before cancelling.
 */
async function reconcilePendingPayments({ now = Date.now() } = {}) {
  const cfg = resolvePaymentConfig();
  const summary = { checked: 0, reconciled: 0 };
  if (!cfg.razorpay.configured) return summary;
  const orders = await getAllOrders({ limit: 300 });
  for (const order of orders) {
    const p = order.payment;
    if (order.status !== AWAITING_PAYMENT || !p || p.method !== "razorpay" || !p.gatewayOrderId) continue;
    if (!(Date.parse(p.expiresAt) >= now)) continue;
    summary.checked += 1;
    try {
      if (await reconcileRazorpayOrder(order, cfg)) summary.reconciled += 1;
    } catch (err) {
      log(`couldn't reach Razorpay to check ${order.token}; will retry: ${err.message}`);
    }
  }
  return summary;
}

/**
 * Cancels orders whose payment window passed. A Razorpay order is checked
 * with Razorpay first, so a payment whose callback never arrived is
 * honoured instead of cancelled.
 */
async function expireStalePayments({ now = Date.now() } = {}) {
  const cfg = resolvePaymentConfig();
  const summary = { expired: 0, reconciled: 0 };
  const orders = await getAllOrders({ limit: 300 });
  for (const order of orders) {
    const p = order.payment;
    if (order.status !== AWAITING_PAYMENT || !p) continue;
    if (!(Date.parse(p.expiresAt) < now)) continue;
    if (p.method === "razorpay" && p.gatewayOrderId) {
      try {
        if (await reconcileRazorpayOrder(order, cfg)) {
          summary.reconciled += 1;
          continue;
        }
      } catch (err) {
        log(`couldn't reach Razorpay to check ${order.token} before expiring it; will retry: ${err.message}`);
        continue;
      }
    }
    const updated = await setPayment(order.orderId, { ...p, status: "expired", expiredAt: nowIso() }, { status: CANCELLED, onlyIfStatus: AWAITING_PAYMENT });
    if (updated) {
      summary.expired += 1;
      log(`order ${order.token} cancelled — not paid within ${cfg.windowMinutes} min`);
    }
  }
  return summary;
}

let sweepTimer = null;
let sweeping = false;
/** Every intervalMs: confirm pending Razorpay payments, then cancel stale orders. */
function startPaymentSweeper({ intervalMs = 15000 } = {}) {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    // A slow Razorpay round never overlaps the next one.
    if (sweeping) return;
    sweeping = true;
    try {
      await reconcilePendingPayments();
      await expireStalePayments();
    } catch (err) {
      log(`payment sweep failed: ${err.message}`);
    } finally {
      sweeping = false;
    }
  }, intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
}

/** Owner dashboard summary of money in, by method. */
async function paymentStats() {
  const orders = await getAllOrders({ limit: 500 });
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const stats = { awaiting: 0, paidToday: 0, collectedTodayRupees: 0, testModeToday: 0, simulatedToday: 0, cancelledToday: 0 };
  for (const o of orders) {
    const p = o.payment;
    if (!p || o.isSample) continue;
    if (o.status === AWAITING_PAYMENT) stats.awaiting += 1;
    if (p.status === "paid" && Date.parse(p.paidAt) >= startOfDay.getTime()) {
      // Neither a simulated nor a Razorpay test-mode payment is money.
      if (p.simulated) stats.simulatedToday += 1;
      else if (p.method === "razorpay" && p.mode === "test") stats.testModeToday += 1;
      else {
        stats.paidToday += 1;
        stats.collectedTodayRupees += p.amountPaise / 100;
      }
    }
    if (o.status === CANCELLED && Date.parse(o.createdAt) >= startOfDay.getTime()) stats.cancelledToday += 1;
  }
  return stats;
}

module.exports = {
  PaymentError,
  publicPayment,
  startPayment,
  completePayment,
  verifyRazorpayCheckout,
  refreshRazorpayPayment,
  handleRazorpayWebhook,
  ensureCaptured,
  simulateDemoPayment,
  reconcilePendingPayments,
  expireStalePayments,
  startPaymentSweeper,
  paymentStats,
  _setRazorpayClientForTests,
};
