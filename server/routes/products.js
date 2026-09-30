const express = require("express");
const { getAllProducts, getProductById, getCategories } = require("../lib/datastore");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

// Fields intentionally NOT sent to the client even though they exist in the
// datastore: none currently — every field here is safe to show a customer.
// (Kept as an explicit allowlist-style comment so a future internal-only
// field, e.g. supplier cost, doesn't get exposed here by accident.)

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { category } = req.query;
    let products = getAllProducts();
    if (typeof category === "string" && category.trim()) {
      const categories = getCategories().map((c) => c.id);
      if (!categories.includes(category)) {
        return res.status(400).json({ error: "Unknown category." });
      }
      products = products.filter((p) => p.category === category);
    }
    res.json({ products, categories: getCategories() });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const product = getProductById(req.params.id);
    if (!product || !product.availability) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.json({ product });
  })
);

module.exports = router;
