/**
 * Customer-facing payment endpoints + the gateway webhook.
 *
 *   POST /api/payments/:orderId/start          (re)open payment for an unpaid order
 *   POST /api/payments/:orderId/verify         Razorpay success callback -> signature check + fetch from Razorpay
 *   POST /api/payments/:orderId/demo           demo provider only: { outcome: "success" | "failure" }
 *   POST /api/payments/:orderId/client-failure customer's browser reports a failed attempt (informational only)
 *   POST /api/payments/webhook                 Razorpay webhook (signed) — mounted separately, see server/index.js
 *
 * The order id (a random UUID) is the customer's handle on their order,
 * same trust model as GET /api/orders/:id. Nothing here can mark an order
 * paid on the browser's word alone: Razorpay results are signature-checked
 * and re-fetched from Razorpay; the demo endpoint only exists while the
 * demo provider (no real money) is active.
 */
const express = require("express");
const { z } = require("zod");
const { getOrder } = require("../lib/orders");
const { asyncHandler } = require("../lib/asyncHandler");
const { getPaymentProvider } = require("../payments");
const svc = require("../payments/service");
const { toSummary } = require("./order");

const router = express.Router();
const idSchema = z.string().uuid();

async function loadOrder(req, res) {
  const parsed = idSchema.safeParse(req.params.orderId);
  const order = parsed.success ? await getOrder(parsed.data) : null;
  if (!order || !order.payment) {
    res.status(404).json({ error: "Order not found." });
    return null;
  }
  return order;
}

router.post(
  "/:orderId/start",
  asyncHandler(async (req, res) => {
    let order = await loadOrder(req, res);
    if (!order) return;
    order = await svc.expireIfStale(order);
    if (order.status !== "AWAITING_PAYMENT") {
      const paid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.payment.status);
      return res.status(409).json({
        error: paid ? "This order is already paid." : "This order expired before payment. Please place it again — you have not been charged.",
        order: toSummary(order),
      });
    }
    const checkout = svc.checkoutParamsFor(order);
    if (!checkout) return res.status(409).json({ error: "Payment settings changed since this order was placed. Please place it again.", order: toSummary(order) });
    res.json({ order: toSummary(order), checkout });
  })
);

const verifySchema = z.object({
  razorpay_order_id: z.string().trim().min(1).max(64),
  razorpay_payment_id: z.string().trim().min(1).max(64),
  razorpay_signature: z.string().trim().min(1).max(256),
});

router.post(
  "/:orderId/verify",
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, res);
    if (!order) return;
    const provider = getPaymentProvider();
    if (provider.name !== "razorpay" || order.payment.provider !== "razorpay") return res.status(400).json({ error: "Unexpected payment confirmation." });
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid payment confirmation." });
    const { razorpay_order_id: gatewayOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = parsed.data;
    if (gatewayOrderId !== order.payment.gatewayOrderId || !provider.verifyCheckoutSignature({ gatewayOrderId, paymentId, signature })) {
      // eslint-disable-next-line no-console
      console.warn(`[payments] rejected an invalid payment signature for order ${order.orderId}`);
      return res.status(400).json({ error: "We couldn't verify this payment. If money was deducted, it will be confirmed automatically in a few minutes." });
    }
    // Signature proves Razorpay issued it; Razorpay's API is still the source of truth for amount/status.
    let gp;
    try {
      gp = await provider.getPayment(paymentId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[payments] could not fetch payment after a valid signature:", err.message);
      return res.status(202).json({ pending: true, order: toSummary(order) });
    }
    const updated = (await svc.applyGatewayPayment(gp, "checkout", order.orderId)) || order;
    res.json({ order: toSummary(updated) });
  })
);

router.post(
  "/:orderId/demo",
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, res);
    if (!order) return;
    const provider = getPaymentProvider();
    if (provider.name !== "demo" || order.payment.provider !== "demo") return res.status(404).json({ error: "Not found." });
    const outcome = req.body && req.body.outcome === "success" ? "success" : "failure";
    const current = await svc.expireIfStale(order);
    const alreadyPaid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(current.payment.status);
    if (alreadyPaid || (current.status !== "AWAITING_PAYMENT" && outcome === "failure")) return res.json({ order: toSummary(current) });
    const gp = provider.simulate(order.payment.gatewayOrderId, order.payment.amountPaise, outcome);
    const updated = (await svc.applyGatewayPayment(gp, "checkout", order.orderId)) || current;
    res.json({ order: toSummary(updated) });
  })
);

const failureSchema = z.object({
  paymentId: z.string().trim().max(64).optional(),
  code: z.string().trim().max(64).optional(),
  reason: z.string().trim().max(300).optional(),
});

router.post(
  "/:orderId/client-failure",
  asyncHandler(async (req, res) => {
    const order = await loadOrder(req, res);
    if (!order) return;
    const parsed = failureSchema.safeParse(req.body || {});
    if (!parsed.success || !parsed.data.paymentId || order.status !== "AWAITING_PAYMENT") return res.json({ ok: true });
    // Informational only: lets the dashboard show *why* an attempt failed
    // even before the gateway webhook arrives. It can never mark anything paid.
    await svc.applyGatewayPayment(
      {
        paymentId: parsed.data.paymentId,
        gatewayOrderId: order.payment.gatewayOrderId,
        status: "failed",
        amountPaise: order.payment.amountPaise,
        errorCode: parsed.data.code || null,
        errorReason: parsed.data.reason || null,
      },
      "client",
      order.orderId
    );
    res.json({ ok: true });
  })
);

/**
 * Razorpay webhook. Configure in Razorpay Dashboard -> Settings -> Webhooks:
 *   URL: https://<your-domain>/api/payments/webhook
 *   Secret: same value as RAZORPAY_WEBHOOK_SECRET
 *   Events: payment.authorized, payment.captured, payment.failed, order.paid,
 *           refund.processed, refund.failed
 * Needs the raw body for the signature, so it's mounted with its own body parser.
 */
const webhookRouter = express.Router();
webhookRouter.post(
  "/",
  express.raw({ type: "*/*", limit: "100kb" }),
  asyncHandler(async (req, res) => {
    const provider = getPaymentProvider();
    if (provider.name !== "razorpay") return res.status(404).json({ error: "Not found." });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!provider.verifyWebhook(raw, req.get("x-razorpay-signature"))) {
      // eslint-disable-next-line no-console
      console.warn("[payments] webhook rejected: bad or missing signature");
      return res.status(400).json({ error: "Invalid signature." });
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch (_e) {
      return res.status(400).json({ error: "Invalid body." });
    }
    const event = provider.parseWebhook(body);
    if (event && event.refund) await svc.applyRefund(event.refund, event.payment);
    else if (event && event.payment) await svc.applyGatewayPayment(event.payment, "webhook");
    // Always 200 once authenticated, so Razorpay doesn't retry events we've handled or deliberately ignore.
    res.json({ ok: true });
  })
);

module.exports = { router, webhookRouter };
