const express = require("express");
const { validateBody, checkoutSchema } = require("../lib/validation");
const { priceCart, PricingError } = require("../lib/pricing");
const { getDeliveryProvider } = require("../delivery");
const { createOrder, setDeliveryOrderId } = require("../lib/orders");
const { notifyNewOrder, getVerificationChannel } = require("../notifications");
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

    const order = await createOrder({ customer, address, pricing, paymentMethod });

    // Demo delivery order creation is fire-and-forget and never blocks the
    // customer's confirmation — a real courier network being briefly slow
    // or down should never fail an already-priced, already-recorded order.
    // The in-memory `order` object is mutated immediately so the response
    // below reflects it, AND persisted back to whichever store is active
    // (setDeliveryOrderId) — with a database-backed store, mutating the
    // plain object alone wouldn't survive a reload, so both matter here.
    provider
      .createDeliveryOrder({ orderId: order.orderId, address, customer })
      .then((deliveryOrder) => {
        order.deliveryOrderId = deliveryOrder.deliveryOrderId;
        return setDeliveryOrderId(order.orderId, deliveryOrder.deliveryOrderId);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[checkout] delivery order creation failed (order still stands):", err);
      });

    // Same fire-and-forget principle: the owner alert and the customer's
    // order slip are side effects of a successful order, not conditions for
    // one. notifyNewOrder() internally catches every failure itself, so
    // this can't reject, but it's still not awaited on the response path —
    // the customer sees their confirmation immediately either way.
    notifyNewOrder(order, { customerPhoneVerified: phoneVerified });

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
    });
  })
);

module.exports = router;
