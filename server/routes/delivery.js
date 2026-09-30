const express = require("express");
const { validateBody, deliveryQuoteSchema } = require("../lib/validation");
const { getDeliveryProvider } = require("../delivery");
const { asyncHandler } = require("../lib/asyncHandler");
const { z } = require("zod");
const { getOrder } = require("../lib/orders");

const router = express.Router();

router.post(
  "/quote",
  validateBody(deliveryQuoteSchema),
  asyncHandler(async (req, res) => {
    const provider = getDeliveryProvider();
    try {
      const quote = await provider.getDeliveryQuote(req.body.address);
      res.json(quote);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[delivery] quote failed:", err);
      res.status(502).json({ error: "Something went wrong while checking delivery availability. Please try again." });
    }
  })
);

/**
 * Courier status for one DE.25 order. Takes the DE.25 order id (a random
 * UUID, the same key the order-tracking page already uses) and looks up the
 * courier's id server-side — it never forwards a caller-supplied courier id,
 * which would let anyone query any delivery on the shop's courier account.
 */
router.get(
  "/status/:orderId",
  asyncHandler(async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.orderId);
    if (!parsed.success) return res.status(404).json({ error: "Order not found." });
    const order = await getOrder(parsed.data);
    if (!order || !order.deliveryOrderId) return res.status(404).json({ error: "Order not found." });
    const provider = getDeliveryProvider();
    try {
      const status = await provider.getDeliveryStatus(order.deliveryOrderId);
      res.json(status);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[delivery] status check failed:", err);
      res.status(502).json({ error: "Something went wrong while checking delivery status. Please try again." });
    }
  })
);

module.exports = router;
