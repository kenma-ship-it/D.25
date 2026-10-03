const express = require("express");
const { validateBody, checkoutSchema } = require("../lib/validation");
const { priceCart, PricingError } = require("../lib/pricing");
const { getDeliveryProvider } = require("../delivery");
const { createOrder, updateOrder } = require("../lib/orders");
const { getVerificationChannel } = require("../notifications");
const { startPayment, customerPaymentSummary } = require("../payments/service");
const { verifyToken } = require("../lib/phoneVerification");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

router.post(
  "/",
  validateBody(checkoutSchema),
  asyncHandler(async (req, res) => {
    const { customer, address, items, paymentMethod, phoneVerificationToken } = req.body;

    // Whenever this site can send WhatsApp codes, an order needs a verified
    // number: it's where the receipt goes, and it stops orders (and
    // receipts) being placed against a stranger's phone. Only a production
    // deployment with no WhatsApp account configured skips this — and there
    // no receipt is sent at all.
    const phoneVerified = verifyToken(phoneVerificationToken || "", customer.phone);
    if (getVerificationChannel().available && !phoneVerified) {
      return res.status(400).json({ error: "Please verify your WhatsApp number with the code we send you before placing the order.", needsVerification: true });
    }

    const provider = getDeliveryProvider();
    let deliveryQuote;
    try {
      deliveryQuote = await provider.getDeliveryQuote(address);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[checkout] delivery quote failed:", err);
      return res.status(502).json({ error: "Something went wrong while checking delivery availability. Please try again." });
    }

    let pricing;
    try {
      pricing = priceCart(items, deliveryQuote);
    } catch (err) {
      if (err instanceof PricingError) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    // The order is recorded first (so a payment can always be matched back to
    // it), but stays AWAITING_PAYMENT: the kitchen, the owner alert, the
    // customer's receipt and the delivery booking all wait until the payment
    // gateway confirms the money arrived (server/payments/service.js).
    const order = await createOrder({ customer: { ...customer, phoneVerified }, address, pricing, paymentMethod });

    let started;
    try {
      started = await startPayment(order);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[checkout] could not start payment:", err.message);
      await updateOrder(order.orderId, { status: "CANCELLED" }).catch(() => {});
      return res.status(502).json({ error: "We couldn't connect to the payment service. Nothing was charged — please try again in a minute." });
    }

    res.status(201).json({
      orderId: order.orderId,
      token: order.token,
      status: started.order.status,
      lines: order.lines,
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      tax: order.tax,
      total: order.total,
      isLiveDelivery: deliveryQuote.isLive,
      deliveryProvider: deliveryQuote.provider,
      payment: customerPaymentSummary(started.order),
      checkout: started.checkout,
    });
  })
);

module.exports = router;
