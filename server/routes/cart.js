const express = require("express");
const { z } = require("zod");
const { priceCart, PricingError } = require("../lib/pricing");
const { validateBody, cartItemSchema } = require("../lib/validation");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

const priceRequestSchema = z.object({ items: z.array(cartItemSchema).min(1).max(30) });

/**
 * Stateless cart pricing. The frontend calls this every time the cart
 * changes so the numbers on screen are always the server's numbers, not a
 * client-side calculation — see the module docstring in lib/pricing.js for
 * why that matters. No delivery fee is included here (that needs an
 * address); checkout computes the final total including delivery.
 */
router.post(
  "/price",
  validateBody(priceRequestSchema),
  asyncHandler(async (req, res) => {
    try {
      const pricing = priceCart(req.body.items, null);
      res.json(pricing);
    } catch (err) {
      if (err instanceof PricingError) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }
  })
);

module.exports = router;
