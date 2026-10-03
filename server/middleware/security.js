const helmet = require("helmet");

/**
 * Security headers, applied globally.
 *
 * This is a single-origin storefront (the frontend is served by this same
 * Express app, not a separate domain calling in) so there is no cross-site
 * API to expose: CORS is left at its default (same-origin only) rather
 * than opened up, and no Access-Control-Allow-Origin header is ever set.
 * If DE.25 later needs a separate frontend origin, add an explicit
 * allowlist here rather than "*".
 */
/**
 * @param {string[]} extraConnectSrc - additional origins the frontend is
 *   allowed to fetch() directly. Used for the owner dashboard's Supabase
 *   Auth login (public/admin/admin.js talks to Supabase's Auth API
 *   directly from the browser with the public anon key — see
 *   server/lib/adminAuthConfig.js) — only added when that's actually
 *   configured, so the default zero-config deployment stays locked to
 *   same-origin only.
 */
/**
 * @param {{scriptSrc?: string[], frameSrc?: string[], imgSrc?: string[], connectSrc?: string[]}} extra -
 *   further origins for one integration, e.g. Razorpay Checkout's script and
 *   iframe — passed only when that integration is active (server/index.js).
 */
function securityHeaders(extraConnectSrc = [], extra = {}) {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Google Fonts stylesheet + the optional Motion CDN enhancement
        // (see public/js/animations.js) are the only third-party loads on
        // this site — everything else is same-origin.
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", ...(extra.scriptSrc || [])],
        imgSrc: ["'self'", "data:", "blob:", ...(extra.imgSrc || [])],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'", ...extraConnectSrc, ...(extra.connectSrc || [])],
        frameSrc: ["'self'", ...(extra.frameSrc || [])],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * Lightweight CSRF mitigation for a cookie-less storefront.
 *
 * There's no session cookie here (no login, no server-side session), which
 * removes the classic CSRF attack path (an attacker's page can't ride a
 * victim's authenticated cookie to place an order, because there is no
 * authenticated cookie). The residual risk is a cross-site page silently
 * POSTing to /api/checkout or /api/cart/price from the victim's browser;
 * this middleware closes that off by requiring state-changing requests to
 * carry an Origin/Referer that matches this server's own origin. GET
 * requests are left alone since they don't change state.
 */
function requireSameOrigin(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.get("origin") || req.get("referer");
  if (!origin) return next(); // same-origin fetches from a first-party page may omit Origin; body validation still applies
  try {
    const originHost = new URL(origin).host;
    if (originHost === req.get("host")) return next();
  } catch (_e) {
    // fall through to reject
  }
  return res.status(403).json({ error: "Request rejected: cross-origin request not allowed." });
}

/** Extra CSP sources for the active payment method: Razorpay Checkout is a script plus an iframe from razorpay.com. */
function paymentCspSources(method) {
  if (method !== "razorpay") return {};
  const razorpay = ["https://*.razorpay.com"];
  return { scriptSrc: razorpay, frameSrc: razorpay, imgSrc: razorpay, connectSrc: razorpay };
}

module.exports = { securityHeaders, requireSameOrigin, paymentCspSources };
