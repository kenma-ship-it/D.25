require("dotenv").config();

const express = require("express");
const path = require("path");

const { securityHeaders, requireSameOrigin } = require("./middleware/security");
const { apiLimiter, writeLimiter, aiLimiter, paymentLimiter } = require("./middleware/rateLimit");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { getAdminAuthMode } = require("./lib/adminAuthConfig");

const { initProducts, getActiveProviderName } = require("./products");
const productsRouter = require("./routes/products");
const cartRouter = require("./routes/cart");
const deliveryRouter = require("./routes/delivery");
const checkoutRouter = require("./routes/checkout");
const orderRouter = require("./routes/order");
const aiGuideRouter = require("./routes/aiGuide");
const customRouter = require("./routes/custom");
const adminRouter = require("./routes/admin");
const verifyRouter = require("./routes/verify");
const review = require("./routes/review");
const payments = require("./routes/payments");
const { getPaymentProvider } = require("./payments");

function parseTrustProxy(value) {
  if (value === undefined || value === "" || value === "false" || value === "0") return false;
  if (value === "true") return true;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 ? hops : false;
}

const app = express();
app.disable("x-powered-by");
// Only trust X-Forwarded-For when the deployment really sits behind a
// proxy — otherwise any client can send a fake one and every per-IP rate
// limit becomes per-request. Set TRUST_PROXY to the number of proxy hops
// (e.g. 1 behind one nginx / Render / Railway router). Default: off.
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

// The owner dashboard's Supabase Auth login (if configured) calls
// Supabase's Auth API directly from the browser, so that origin needs an
// explicit connect-src allowance — see server/middleware/security.js.
const adminAuthMode = getAdminAuthMode();
const cspConnectSrc = adminAuthMode.mode === "supabase" ? [adminAuthMode.supabaseUrl] : [];
// Razorpay Checkout runs in an iframe from Razorpay's own domains — allowed
// only when Razorpay is the active payment provider.
const razorpayCsp = getPaymentProvider().name === "razorpay";
app.use(securityHeaders(cspConnectSrc, { razorpay: razorpayCsp }));

// Payment gateway webhook: needs the raw body for its signature, and must
// not share the per-IP API rate limit with customers (the gateway sends
// bursts from a few IPs). Registered before the JSON parser and limiter.
app.use("/api/payments/webhook", payments.webhookRouter);

app.use(express.json({ limit: "50kb" })); // small, deliberate cap — nothing this app accepts legitimately needs more
app.use(requireSameOrigin);

// QR review page: /review/ is static (public/review/). "/review.html" is a
// short form people may type. The QR code + printable card are owner-only
// (owner dashboard, /api/admin/review-qr.*).
app.get("/review.html", (_req, res) => res.redirect(302, "/review/"));

// Static frontend. Images/fonts/CSS/JS are all under public/ and served
// read-only; express.static resolves paths safely (no path traversal via
// "..", it 404s those) so no extra hardening is needed here.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: "1h",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".jpg") || filePath.endsWith(".png") || filePath.endsWith(".webp")) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  })
);

app.use("/api", apiLimiter);
app.use("/api/products", productsRouter);
app.use("/api/cart", cartRouter);
app.use("/api/delivery", writeLimiter, deliveryRouter);
app.use("/api/checkout", writeLimiter, checkoutRouter);
app.use("/api/payments", paymentLimiter, payments.router);
app.use("/api/orders", orderRouter);
app.use("/api/verify", writeLimiter, verifyRouter);
app.use("/api/ai-guide", aiLimiter, aiGuideRouter);
app.use("/api/custom-enquiry", writeLimiter, customRouter);
app.use("/api/admin", adminRouter);
app.use("/api/review", review.apiRouter);

app.use("/api", notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  // The product catalog must be loaded before the server accepts requests —
  // see server/products/index.js for why this can never reject (a
  // misconfigured Google Sheet falls back to the JSON catalog instead of
  // stopping boot).
  initProducts().then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`DE.25 server listening on http://localhost:${PORT}`);
      // eslint-disable-next-line no-console
      console.log(`[products] ${getActiveProviderName()} catalog active.`);
      if (String(process.env.BORZO_DELIVERY_ENABLED || "false").toLowerCase() === "true") {
        // eslint-disable-next-line no-console
        console.log("[delivery] BORZO_DELIVERY_ENABLED=true");
      } else {
        // eslint-disable-next-line no-console
        console.log("[delivery] Demo delivery provider active (Borzo disabled).");
      }
    });
  });
}

module.exports = { app };
