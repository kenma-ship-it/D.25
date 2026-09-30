const rateLimit = require("express-rate-limit");

/** General API traffic — generous, just stops naive scripted abuse. */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again shortly." },
});

/** Checkout and delivery-quote endpoints — tighter, since these are the ones that cost money (Borzo calls) or write orders. */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again shortly." },
});

/** The AI Food Guide — cheap to run (no external API calls) but still bot-protected. */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many questions — please wait a moment and try again." },
});

/**
 * Order lookup by phone number ("My Orders") — there is no customer login
 * in this demo, so a phone number is the "key" a returning customer types
 * in, the same trust model the single-order-by-id lookup already uses
 * (see server/routes/order.js). A tighter limit than general API traffic
 * makes trying many phone numbers to fish for someone else's orders
 * meaningfully slower and noisier, on top of the phone itself needing to
 * be a real 10-digit number that actually placed an order.
 */
const phoneLookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again shortly." },
});

/**
 * Second limit on the same route, keyed on the phone number being looked up
 * rather than the caller's IP — so rotating IPs doesn't allow unlimited
 * lookups of one person's number.
 */
const phoneTargetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `phone:${String(req.params.phone || "").replace(/\D/g, "").slice(-10)}`,
  message: { error: "Too many lookups for this number — please try again later." },
});

module.exports = { apiLimiter, writeLimiter, aiLimiter, phoneLookupLimiter, phoneTargetLimiter };
