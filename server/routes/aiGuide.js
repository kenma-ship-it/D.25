const express = require("express");
const { validateBody, aiGuideSchema } = require("../lib/validation");
const { answer } = require("../ai/foodGuide");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

router.post(
  "/",
  validateBody(aiGuideSchema),
  asyncHandler(async (req, res) => {
    const { message, productId } = req.body;
    const result = answer(message, productId);
    res.json(result);
  })
);

module.exports = router;
