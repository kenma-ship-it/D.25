/**
 * Customer-side payment endpoints, all scoped to one order id (a random
 * UUID — the same stand-in for authorization as GET /api/orders/:id):
 *
 *   POST /api/payments/:orderId/razorpay/verify   Razorpay Checkout's success callback
 *   POST /api/payments/:orderId/razorpay/refresh  "I've paid" — ask Razorpay directly
 *   POST /api/payments/:orderId/demo/simulate     demo mode only, never production
 *
 * The Razorpay webhook is mounted separately in server/index.js because it
 * needs the raw request body to check Razorpay's signature.
 */
const express = require("express");
const { z } = require("zod");
const { validateBody } = require("../lib/validation");
const { asyncHandler } = require("../lib/asyncHandler");
const payments = require("../payments");
const { toSummary } = require("./order");

const router = express.Router();

const razorpayCallbackSchema = z.object({
  razorpay_order_id: z.string().trim().min(1).max(64),
  razorpay_payment_id: z.string().trim().min(1).max(64),
  razorpay_signature: z.string().trim().min(1).max(128),
});

function respond(res, result) {
  if (!result || !result.order) return res.status(404).json({ error: "Order not found." });
  return res.json(toSummary(result.order));
}

function handled(fn) {
  return asyncHandler(async (req, res) => {
    try {
      respond(res, await fn(req));
    } catch (err) {
      if (err instanceof payments.PaymentError) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }
  });
}

router.post(
  "/:orderId/razorpay/verify",
  validateBody(razorpayCallbackSchema),
  handled((req) => payments.verifyRazorpayCheckout(req.params.orderId, req.body))
);
router.post("/:orderId/razorpay/refresh", handled((req) => payments.refreshRazorpayPayment(req.params.orderId)));
router.post("/:orderId/demo/simulate", handled((req) => payments.simulateDemoPayment(req.params.orderId)));

module.exports = router;
