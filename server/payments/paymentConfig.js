/**
 * Which way DE.25 collects money, read from env vars only (never the
 * browser), the same way borzoConfig.js decides the courier network:
 *
 *   razorpay  RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET set. Razorpay Checkout
 *             (UPI QR, UPI apps, cards, netbanking, wallets); every payment
 *             is verified server-side (signature, webhook or Razorpay's API)
 *             and confirms the order by itself.
 *             rzp_test_ keys = Razorpay test mode, no real money;
 *             rzp_live_ keys = real money (needs Razorpay KYC).
 *   demo      Nothing configured. A clearly labelled "simulate payment"
 *             button, refused outright when NODE_ENV=production.
 *
 * PAYMENT_PROVIDER=razorpay|demo forces one; left empty, Razorpay wins when
 * its keys are set. Secrets stay on the server: only the Razorpay key id
 * (public by design) ever reaches the browser.
 */

const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/;
const DEFAULT_WINDOW_MINUTES = 30;

function clean(v) {
  return String(v || "").trim();
}

function razorpayStatus(env) {
  const keyId = clean(env.RAZORPAY_KEY_ID);
  const keySecret = clean(env.RAZORPAY_KEY_SECRET);
  const webhookSecret = clean(env.RAZORPAY_WEBHOOK_SECRET);
  const problems = [];
  if (!keyId) problems.push("RAZORPAY_KEY_ID is not set");
  else if (!KEY_ID_PATTERN.test(keyId)) problems.push("RAZORPAY_KEY_ID doesn't look like a Razorpay key (rzp_test_… or rzp_live_…)");
  if (!keySecret) problems.push("RAZORPAY_KEY_SECRET is not set");
  const match = KEY_ID_PATTERN.exec(keyId);
  return {
    configured: problems.length === 0,
    problems,
    keyId: problems.length === 0 ? keyId : null,
    keySecret: problems.length === 0 ? keySecret : null,
    mode: match ? match[1] : null,
    webhookSecret: webhookSecret || null,
  };
}

function resolvePaymentConfig(env = process.env) {
  const requested = clean(env.PAYMENT_PROVIDER).toLowerCase();
  const razorpay = razorpayStatus(env);
  const isProduction = env.NODE_ENV === "production";
  const windowMinutes = Number(env.PAYMENT_WINDOW_MINUTES) > 0 ? Math.min(Number(env.PAYMENT_WINDOW_MINUTES), 24 * 60) : DEFAULT_WINDOW_MINUTES;

  let method;
  const problems = [];
  if (requested && !["razorpay", "demo"].includes(requested)) {
    problems.push(`PAYMENT_PROVIDER="${requested}" is not one of razorpay, demo`);
  }
  if (requested === "razorpay") {
    method = razorpay.configured ? "razorpay" : null;
    problems.push(...razorpay.problems);
  } else if (requested === "demo") {
    method = "demo";
  } else {
    method = razorpay.configured ? "razorpay" : "demo";
    // Something was set but is wrong — say so instead of quietly skipping it.
    const touched = Object.keys(env).some((k) => k.startsWith("RAZORPAY_") && clean(env[k]));
    if (!razorpay.configured && touched) problems.push(...razorpay.problems);
  }

  // A demo "simulate payment" button on a production site would let anyone
  // take food for free — so production with nothing real configured takes
  // no orders at all rather than fake-paid ones.
  if (method === "demo" && isProduction) {
    method = null;
    problems.push("demo payments are disabled when NODE_ENV=production — set the Razorpay keys");
  }
  // A misconfigured explicit choice never silently becomes a different one.
  if (method === null && !problems.length) problems.push("no payment method is configured");

  return {
    method, // "razorpay" | "demo" | null (checkout refuses orders)
    requested: requested || null,
    problems,
    windowMinutes,
    isProduction,
    razorpay,
  };
}

/** Safe to show the owner dashboard: what's set, never a secret's value. */
function describePaymentConfig(cfg = resolvePaymentConfig()) {
  const keyId = cfg.razorpay.keyId;
  return {
    method: cfg.method,
    requested: cfg.requested,
    problems: cfg.problems,
    windowMinutes: cfg.windowMinutes,
    razorpay: {
      configured: cfg.razorpay.configured,
      mode: cfg.razorpay.mode,
      keyIdHint: keyId ? `${keyId.slice(0, 13)}…${keyId.slice(-4)}` : null,
      hasKeySecret: Boolean(cfg.razorpay.keySecret),
      hasWebhookSecret: Boolean(cfg.razorpay.webhookSecret),
    },
  };
}

module.exports = { resolvePaymentConfig, describePaymentConfig, KEY_ID_PATTERN };
