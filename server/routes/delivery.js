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
      console.error("[delivery] quote failed:", err.message);
      res.status(502).json({
        error: err.publicMessage || "Something went wrong while checking delivery availability. Please try again.",
      });
    }
  })
);

/**
 * Courier status for one DE.25 order. Takes the DE.25 order id (a random
 * UUID, the same key the order-tracking page already uses) and answers from
 * the delivery record stored on the order — which delivery/borzoSync.js
 * keeps fresh. It never forwards a caller-supplied courier id (that would
 * let anyone query any delivery on the shop's courier account), and a
 * public page refresh never turns into a call against the shop's Borzo
 * quota. The courier's phone number is left out: only the customer's own
 * Borzo tracking page shows that.
 */
router.get(
  "/status/:orderId",
  asyncHandler(async (req, res) => {
    const parsed = z.string().uuid().safeParse(req.params.orderId);
    if (!parsed.success) return res.status(404).json({ error: "Order not found." });
    const order = await getOrder(parsed.data);
    if (!order || !order.delivery) return res.status(404).json({ error: "Order not found." });
    const d = order.delivery;
    res.json({
      provider: d.provider,
      environment: d.environment || null,
      isLive: Boolean(d.isLive),
      deliveryOrderId: d.deliveryOrderId || null,
      status: d.status,
      statusLabel: d.statusLabel,
      trackingUrl: d.trackingUrl || null,
      courierName: d.courier ? d.courier.name : null,
      lastSyncedAt: d.lastSyncedAt || null,
    });
  })
);

module.exports = router;
