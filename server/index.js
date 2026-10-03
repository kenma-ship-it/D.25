// Resolve .env next to the project, not the shell's cwd, so `node server/index.js`
// behaves the same whichever directory it is launched from.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express = require("express");
const path = require("path");

const { securityHeaders, requireSameOrigin, paymentCspSources } = require("./middleware/security");
const { apiLimiter, writeLimiter, aiLimiter } = require("./middleware/rateLimit");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const { getAdminAuthMode } = require("./lib/adminAuthConfig");
const { resolveBorzoConfig } = require("./delivery/borzoConfig");
const { startBorzoSync } = require("./delivery/borzoSync");
const { resolvePaymentConfig } = require("./payments/paymentConfig");
const { handleRazorpayWebhook, startPaymentSweeper } = require("./payments");
const { asyncHandler } = require("./lib/asyncHandler");

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
const paymentsRouter = require("./routes/payments");

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
// Razorpay Checkout's script and iframe are allowed only when Razorpay is
// the active payment method (decided at startup, like the rest of .env).
app.use(securityHeaders(cspConnectSrc, paymentCspSources(resolvePaymentConfig().method)));

// Razorpay's server-to-server webhook. Registered before express.json()
// because the signature is an HMAC of the exact raw bytes Razorpay sent.
app.post(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "*/*", limit: "256kb" }),
  asyncHandler(async (req, res) => {
    const result = await handleRazorpayWebhook(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get("x-razorpay-signature"));
    res.status(result.status).json(result.body);
  })
);

app.use(express.json({ limit: "50kb" })); // small, deliberate cap — nothing this app accepts legitimately needs more
app.use(requireSameOrigin);

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
app.use("/api/payments", writeLimiter, paymentsRouter);
app.use("/api/orders", orderRouter);
app.use("/api/verify", writeLimiter, verifyRouter);
app.use("/api/ai-guide", aiLimiter, aiGuideRouter);
app.use("/api/custom-enquiry", writeLimiter, customRouter);
app.use("/api/admin", adminRouter);

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
      const borzo = resolveBorzoConfig();
      if (borzo.active) {
        // eslint-disable-next-line no-console
        console.log(`[delivery] Borzo ${borzo.environment === "production" ? "PRODUCTION (real couriers)" : "sandbox"} active — ${borzo.baseUrl}`);
        startBorzoSync();
      } else {
        // eslint-disable-next-line no-console
        console.log(`[delivery] Demo delivery provider active. Borzo needs: ${borzo.problems.join("; ")}.`);
      }
      const pay = resolvePaymentConfig();
      const payLabel = {
        razorpay: `Razorpay ${pay.razorpay.mode === "live" ? "LIVE (real money)" : "test mode (no real money)"}${pay.razorpay.webhookSecret ? " + webhook" : ", no webhook secret"}`,
        demo: "DEMO — payments are simulated, no money moves",
      }[pay.method];
      // eslint-disable-next-line no-console
      console.log(pay.method ? `[payments] ${payLabel}.` : `[payments] NOT AVAILABLE — checkout will refuse orders: ${pay.problems.join("; ")}.`);
      if (pay.method && pay.problems.length) console.warn(`[payments] note: ${pay.problems.join("; ")}`); // eslint-disable-line no-console
      startPaymentSweeper();
    });
  });
}

module.exports = { app };
