/**
 * Phone verification over WhatsApp.
 *
 *   POST /api/verify/phone/request  { phone }        -> sends a 6-digit code
 *   POST /api/verify/phone/confirm  { phone, code }  -> { verificationToken }
 *
 * The token is what "My Orders" (X-Phone-Verification header) and checkout
 * (phoneVerificationToken field) require. See server/lib/phoneVerification.js.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const { phone: phoneSchema } = require("../lib/validation");
const { asyncHandler } = require("../lib/asyncHandler");
const { issueCode, cancelCode, confirmCode, VerificationError, MAX_ATTEMPTS } = require("../lib/phoneVerification");
const { getNotificationProvider, getVerificationChannel } = require("../notifications");

const router = express.Router();

const digitsOf = (req) => String((req.body && req.body.phone) || "").replace(/\D/g, "").slice(-10);

/** Each code costs the shop a WhatsApp message, so cap sends per number, not just per IP. */
const perPhoneSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `verify-send:${digitsOf(req)}`,
  message: { error: "Too many codes requested for this number. Please try again in an hour." },
});

const confirmLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a few minutes and try again." },
});

const requestSchema = z.object({ phone: phoneSchema });
const confirmSchema = z.object({
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, "Please enter the 6-digit code."),
});

function sendVerificationError(res, err) {
  const body = { error: err.message };
  if (err.attemptsLeft !== undefined) body.attemptsLeft = err.attemptsLeft;
  if (err.retryAfterSeconds !== undefined) body.retryAfterSeconds = err.retryAfterSeconds;
  return res.status(err.statusCode).json(body);
}

router.post(
  "/phone/request",
  perPhoneSendLimiter,
  asyncHandler(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Please enter a valid 10-digit mobile number." });
    const { phone } = parsed.data;

    const channel = getVerificationChannel();
    if (!channel.available) {
      return res.status(503).json({ error: "WhatsApp verification isn't set up on this site yet. Please contact DE.25 on Instagram." });
    }

    let issued;
    try {
      issued = issueCode(phone);
    } catch (err) {
      if (err instanceof VerificationError) return sendVerificationError(res, err);
      throw err;
    }

    const result = await getNotificationProvider()
      .sendVerificationCode(phone, issued.code)
      .catch((err) => ({ sent: false, error: err.message }));
    if (!result.sent) {
      cancelCode(phone);
      // eslint-disable-next-line no-console
      console.error("[verify] sending code failed:", result.error);
      return res.status(502).json({ error: "We couldn't send the code on WhatsApp just now. Please check the number and try again." });
    }

    res.json({
      sent: true,
      channel: channel.channel,
      expiresInSeconds: issued.expiresInSeconds,
      resendInSeconds: issued.resendInSeconds,
      maxAttempts: MAX_ATTEMPTS,
      // Only ever present in non-production demo mode (no WhatsApp account
      // configured) — see getVerificationChannel(). Never in production.
      ...(channel.exposeCode ? { demoCode: issued.code } : {}),
    });
  })
);

router.post(
  "/phone/confirm",
  confirmLimiter,
  asyncHandler(async (req, res) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Please enter the 6-digit code." });
    try {
      const { token, expiresInSeconds } = confirmCode(parsed.data.phone, parsed.data.code);
      res.json({ verified: true, verificationToken: token, expiresInSeconds });
    } catch (err) {
      if (err instanceof VerificationError) return sendVerificationError(res, err);
      throw err;
    }
  })
);

module.exports = router;
