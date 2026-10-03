const express = require("express");
const { z } = require("zod");
const { getOrder, getOrdersByPhone } = require("../lib/orders");
const { asyncHandler } = require("../lib/asyncHandler");
const { phone: phoneSchema } = require("../lib/validation");
const { phoneLookupLimiter, phoneTargetLimiter } = require("../middleware/rateLimit");
const { verifyToken } = require("../lib/phoneVerification");
const payments = require("../payments/service");

const router = express.Router();

const idSchema = z.string().uuid();

function toSummary(order) {
  return {
    orderId: order.orderId,
    token: order.token,
    status: order.status,
    statusHistory: order.statusHistory,
    lines: order.lines,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    tax: order.tax,
    total: order.total,
    isLiveDelivery: order.deliveryQuote ? order.deliveryQuote.isLive : false,
    createdAt: order.createdAt,
    payment: payments.customerPaymentSummary(order),
  };
}

/**
 * "My Orders": look up every order placed with a given phone number, so a
 * returning customer with no account can see their past orders and the
 * live status of anything still in progress. Same trust model as the
 * single-order lookup below — the phone number itself is the
 * "authorization" in this accountless demo — but a phone number is far
 * more guessable than a random order id, so this route additionally gets
 * its own tight rate limit (phoneLookupLimiter) on top of the general API
 * limiter, and returns an empty list rather than a 404 for a phone number
 * that placed no orders (so the response shape never confirms or denies
 * whether a given number has an account elsewhere in the system).
 *
 * Route order note: this is declared before the generic "/:id" route
 * below, but the two can never actually collide — "/:id" only ever
 * matches a single path segment, so a two-segment path like
 * "/by-phone/9876543210" is never a candidate for it regardless of
 * declaration order.
 */
router.get(
  "/by-phone/:phone",
  phoneLookupLimiter,
  phoneTargetLimiter,
  asyncHandler(async (req, res) => {
    const parsed = phoneSchema.safeParse(req.params.phone);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Please enter a valid 10-digit mobile number." });
    }
    // The phone number alone is no longer enough: the caller must show a
    // token proving they just received a WhatsApp code on this number
    // (POST /api/verify/phone/request + /confirm).
    if (!verifyToken(req.get("x-phone-verification") || "", parsed.data)) {
      return res.status(401).json({ error: "Please verify this number with the WhatsApp code first.", needsVerification: true });
    }
    const orders = await payments.sweep(await getOrdersByPhone(parsed.data), { maxChecks: 2 });
    res.json({ orders: orders.map(toSummary) });
  })
);

/**
 * Order lookup by id. There is no customer login in this demo, so the
 * order id itself (a random UUIDv4, not a sequential integer) is what
 * stands in for authorization — it is not guessable or enumerable, which
 * is the standard mitigation for this pattern (the same one order-tracking
 * emails from most e-commerce sites rely on). A sequential id here would
 * be a textbook IDOR; a UUID is not guaranteed unguessable forever, so a
 * real production build should still gate this behind a logged-in
 * customer session once accounts exist.
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(404).json({ error: "Order not found." });

    let order = await getOrder(parsed.data);
    if (!order) return res.status(404).json({ error: "Order not found." });
    // An unpaid order being watched by its customer: expire it or re-check
    // the gateway (throttled) so "paid but page closed" resolves itself.
    [order] = await payments.sweep([order], { maxChecks: 1 });

    res.json(toSummary(order));
  })
);

module.exports = router;
module.exports.toSummary = toSummary;
