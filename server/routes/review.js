/**
 * QR review page (public/review/) — customers scan the QR on the counter
 * card, rate, pick what they had, get an AI-drafted review (Grok, with a
 * built-in backup writer) and are sent to DE.25's Google review screen to
 * paste and post it. Merged in from the standalone de25-reviews app so it
 * runs on the same domain as the shop: https://<domain>/review
 *
 *   GET  /review/            review page (static, public/review/index.html)
 *   GET  /api/admin/review-qr.svg|png  QR code pointing at <site>/review/ —
 *        owner only; the printable card lives in the owner dashboard (/admin)
 *   GET  /api/review/config  Google link, tags, review page address
 *   GET  /api/review/menu    categories + items, from the shop's own catalog
 *   POST /api/review/suggest { rating, items, tags, seed } -> { text, engine }
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const QRCode = require("qrcode");
const { getAllProducts } = require("../lib/datastore");
const { asyncHandler } = require("../lib/asyncHandler");
const { POSITIVE_TAGS, ISSUE_TAGS, tagsForRating, suggestReview, getGoogleReviewUrl } = require("../lib/reviewSuggest");

// Same four groups as the homepage menu (public/js/cinematicMenu.js).
const REVIEW_CATEGORIES = [
  { id: "cakes", label: "Cakes" },
  { id: "pastries", label: "Pastries" },
  { id: "savouries", label: "Savouries" },
  { id: "sips", label: "Sips" },
];

/** Public address of the site — PUBLIC_SITE_URL once a domain is set, else the address it was visited on. */
function siteBaseUrl(req) {
  const configured = (process.env.PUBLIC_SITE_URL || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^\s/]+/i.test(configured)) return configured;
  return `${req.protocol}://${req.get("host")}`;
}
const reviewPageUrl = (req) => `${siteBaseUrl(req)}/review/`;

/** Only available products, so a draft can never mention something the shop doesn't sell. */
function reviewMenu() {
  const items = getAllProducts()
    .filter((p) => p.availability !== false)
    .map((p) => ({ id: p.productId, name: p.name, category: p.category }));
  return { categories: REVIEW_CATEGORIES, items };
}

/* ---------- QR code (served by the admin router, behind the owner login) ---------- */
function reviewQrSvg(req) {
  return QRCode.toString(reviewPageUrl(req), { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#0d0c0b", light: "#ffffff" } });
}
function reviewQrPng(req) {
  return QRCode.toBuffer(reviewPageUrl(req), { type: "png", width: 1200, margin: 2, errorCorrectionLevel: "M" });
}

/* ---------- API (mounted at /api/review) ---------- */
const apiRouter = express.Router();

apiRouter.get("/config", (req, res) => {
  const google = getGoogleReviewUrl();
  res.json({
    googleReviewUrl: google.url,
    googleConfigured: google.configured,
    reviewPageUrl: reviewPageUrl(req),
    mainSiteUrl: "/",
    tags: {
      positive: Object.entries(POSITIVE_TAGS).map(([id, label]) => ({ id, label })),
      issues: Object.entries(ISSUE_TAGS).map(([id, label]) => ({ id, label })),
    },
  });
});

apiRouter.get("/menu", (_req, res) => res.json(reviewMenu()));

const suggestSchema = z.object({
  rating: z.number({ invalid_type_error: "Please pick a star rating." }).int().min(1, "Please pick a star rating.").max(5, "Please pick a star rating."),
  items: z.array(z.string().trim().min(1).max(80)).max(8, "Pick up to 8 items.").default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
  seed: z.number().int().min(1).max(1_000_000).default(1),
});

// Each Grok call costs money — keep drafts to a human pace per visitor.
const suggestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "That's a lot of drafts! Please wait a few minutes and try again." },
});

apiRouter.post(
  "/suggest",
  suggestLimiter,
  asyncHandler(async (req, res) => {
    const parsed = suggestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid request." });
    const { rating, items, tags, seed } = parsed.data;

    // Only real menu items, by id — names come from the shop's catalog.
    const byId = new Map(reviewMenu().items.map((i) => [i.id, i]));
    const itemNames = [...new Set(items)].map((id) => byId.get(id)).filter(Boolean).map((i) => i.name);
    if (items.length && !itemNames.length) return res.status(400).json({ error: "Please pick items from the menu." });

    // Only tags offered for this rating, by id.
    const allowed = tagsForRating(rating);
    const tagLabels = { positive: [], issues: [] };
    for (const id of new Set(tags)) {
      if (!allowed[id]) continue;
      if (POSITIVE_TAGS[id] === allowed[id]) tagLabels.positive.push(allowed[id]);
      else tagLabels.issues.push(allowed[id]);
    }

    res.json(await suggestReview({ rating, itemNames, tagLabels, seed }));
  })
);

module.exports = { apiRouter, reviewQrSvg, reviewQrPng, reviewPageUrl };
