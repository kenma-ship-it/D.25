/**
 * Payment provider factory — same pattern as server/delivery/index.js and
 * server/notifications/index.js. Demo until a real gateway is configured:
 *
 *   PAYMENTS_PROVIDER=razorpay
 *   RAZORPAY_KEY_ID=rzp_live_...      (public, sent to the browser)
 *   RAZORPAY_KEY_SECRET=...           (secret, server only)
 *   RAZORPAY_WEBHOOK_SECRET=...       (secret, server only)
 *
 * Asking for Razorpay without both keys logs a warning and stays on demo,
 * so a half-finished setup can never take real orders it can't charge for.
 */
const { DemoPaymentProvider } = require("./DemoPaymentProvider");
const { RazorpayPaymentProvider } = require("./RazorpayPaymentProvider");

let cached = null;

function buildProvider() {
  const wanted = String(process.env.PAYMENTS_PROVIDER || "demo").trim().toLowerCase();
  if (wanted === "razorpay") {
    const keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
    const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
    if (keyId && keySecret) {
      if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
        // eslint-disable-next-line no-console
        console.warn(
          "[payments] RAZORPAY_WEBHOOK_SECRET is not set — payments still work, but a customer who pays and closes the page " +
            "before returning is only caught by the dashboard's payment check, not instantly. Set up the webhook."
        );
      }
      return new RazorpayPaymentProvider({ keyId, keySecret, webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim() });
    }
    // eslint-disable-next-line no-console
    console.warn("[payments] PAYMENTS_PROVIDER=razorpay but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not both set — using demo payments.");
  }
  return new DemoPaymentProvider();
}

function getPaymentProvider() {
  if (!cached) cached = buildProvider();
  return cached;
}

/** Test-only. */
function _setPaymentProvider(provider) {
  cached = provider;
}
function _resetPaymentProvider() {
  cached = null;
}

module.exports = { getPaymentProvider, _setPaymentProvider, _resetPaymentProvider };
