const express = require("express");
const { validateBody, checkoutSchema } = require("../lib/validation");
const { PricingError } = require("../lib/pricing");
const { getVerificationChannel } = require("../notifications");
const { verifyToken } = require("../lib/phoneVerification");
const { createPendingOrder } = require("../lib/placeOrder");
const { resolvePaymentConfig } = require("../payments/paymentConfig");
const { startPayment, PaymentError } = require("../payments");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

router.post(
  "/",
  validateBody(checkoutSchema),
  asyncHandler(async (req, res) => {
    const { customer, address, items, phoneVerificationToken } = req.body;

    // Whenever this site can send WhatsApp codes, an order needs a verified
    // number: it's where the receipt goes, and it stops orders (and
    // receipts) being placed against a stranger's phone. Only a production
    // deployment with no WhatsApp account configured skips this — and there
    // no receipt is sent at all.
    const phoneVerified = verifyToken(phoneVerificationToken || "", customer.phone);
    if (getVerificationChannel().available && !phoneVerified) {
      return res.status(400).json({ error: "Please verify your WhatsApp number with the code we send you before placing the order.", needsVerification: true });
    }

    // The server, not the browser, decides how money is collected — see
    // payments/paymentConfig.js. No working method means no orders, never
    // unpaid ones.
    const payments = resolvePaymentConfig();
    if (!payments.method) {
      // eslint-disable-next-line no-console
      console.error("[checkout] refusing order — online payment isn't set up:", payments.problems.join("; "));
      return res.status(503).json({ error: "Online payment isn't available right now, so DE.25 can't take orders on the website. Please call the shop to order." });
    }

    // Quote -> price -> store as AWAITING_PAYMENT; see lib/placeOrder.js.
    // The courier is booked and notifications sent only once payment is
    // confirmed (payments/index.js).
    let placed;
    try {
      placed = await createPendingOrder({
        customer,
        address,
        items,
        paymentMethod: payments.method,
        windowMinutes: payments.windowMinutes,
        customerPhoneVerified: phoneVerified,
      });
    } catch (err) {
      if (err instanceof PricingError) return res.status(err.statusCode).json({ error: err.message });
      if (err.stage !== "quote") throw err;
      // eslint-disable-next-line no-console
      console.error("[checkout] delivery quote failed:", err.message);
      return res.status(502).json({
        error: err.publicMessage || "Something went wrong while checking delivery availability. Please try again.",
      });
    }
    const { order, deliveryQuote } = placed;

    let payment;
    try {
      payment = await startPayment(order, payments);
    } catch (err) {
      if (err instanceof PaymentError) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    res.status(201).json({
      orderId: order.orderId,
      token: order.token,
      status: order.status,
      lines: order.lines,
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      tax: order.tax,
      total: order.total,
      isLiveDelivery: deliveryQuote.isLive,
      deliveryProvider: deliveryQuote.provider,
      deliveryEnvironment: deliveryQuote.environment || null,
      payment,
    });
  })
);

module.exports = router;
