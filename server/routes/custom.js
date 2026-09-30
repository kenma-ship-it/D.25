const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { validateBody, customEnquirySchema } = require("../lib/validation");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

// Fixed path — never derived from user input, so there is no path-traversal
// surface here even though this handles a file write.
const ENQUIRIES_PATH = path.join(__dirname, "..", "..", "data", "custom-enquiries.json");

async function appendEnquiry(entry) {
  let existing = [];
  try {
    const raw = await fs.readFile(ENQUIRIES_PATH, "utf8");
    existing = JSON.parse(raw);
    if (!Array.isArray(existing)) existing = [];
  } catch (_err) {
    existing = [];
  }
  existing.push(entry);
  await fs.mkdir(path.dirname(ENQUIRIES_PATH), { recursive: true });
  await fs.writeFile(ENQUIRIES_PATH, JSON.stringify(existing, null, 2), "utf8");
}

router.post(
  "/",
  validateBody(customEnquirySchema),
  asyncHandler(async (req, res) => {
    const entry = { ...req.body, receivedAt: new Date().toISOString() };
    try {
      await appendEnquiry(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[custom-enquiry] failed to persist:", err);
      return res.status(500).json({ error: "Something went wrong while sending your enquiry. Please try again." });
    }
    res.status(201).json({ received: true });
  })
);

module.exports = router;
