/**
 * Admin API — backs the owner dashboard (public/admin/). Every route below
 * the /auth-config one is gated by adminAuth (see
 * server/middleware/adminAuth.js): disabled entirely (404) unless admin
 * auth is configured (ADMIN_TOKEN, or Supabase Auth — see
 * server/lib/adminAuthConfig.js), and requires valid credentials otherwise.
 */
const express = require("express");
const fs = require("fs");
const { z } = require("zod");
const { getAllProducts, getProductById, setProduct } = require("../lib/datastore");
const { refreshProducts, getActiveProviderName } = require("../products");
const { getOrder, getAllOrders, advanceStatus, AWAITING_PAYMENT, CANCELLED } = require("../lib/orders");
const { getNotificationProvider } = require("../notifications");
const { LOG_PATH: NOTIFICATIONS_LOG_PATH } = require("../notifications/DemoNotificationProvider");
const { adminAuth } = require("../middleware/adminAuth");
const { getAdminAuthMode } = require("../lib/adminAuthConfig");
const { validateBody } = require("../lib/validation");
const { asyncHandler } = require("../lib/asyncHandler");
const { getDeliveryProvider } = require("../delivery");
const { resolveBorzoConfig, publicBorzoConfig } = require("../delivery/borzoConfig");
const { listActivity, activityStats } = require("../delivery/borzoActivity");
const { runConnectionCheck } = require("../delivery/borzoConnectionCheck");
const { syncBorzoDeliveries, lastSync } = require("../delivery/borzoSync");
const { createSampleOrders, SampleOrdersRefused } = require("../lib/sampleOrders");
const { resolvePaymentConfig, describePaymentConfig } = require("../payments/paymentConfig");
const payments = require("../payments");

const idSchema = z.string().uuid();

const router = express.Router();

/**
 * Public on purpose (registered before router.use(adminAuth) below) — the
 * dashboard needs to know which login form to render (token field vs.
 * email/password) before it has any credentials to send. It still 404s
 * when nothing is configured, preserving the "don't advertise an admin
 * surface exists" property, and it never returns SUPABASE_JWT_SECRET or
 * SUPABASE_SERVICE_ROLE_KEY — only the anon key, which Supabase's own
 * design treats as safe to expose to browsers (Row Level Security, not
 * anon-key secrecy, is what protects data).
 */
router.get(
  "/auth-config",
  asyncHandler(async (req, res) => {
    const config = getAdminAuthMode();
    if (config.mode === "none") return res.status(404).json({ error: "Not found." });
    if (config.mode === "supabase") {
      return res.json({ provider: "supabase", supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey });
    }
    return res.json({ provider: "token" });
  })
);

router.use(adminAuth);

// Deliberately an allowlist of editable fields — productId, and anything
// not listed here (e.g. computed fields), can never be overwritten via
// this endpoint no matter what the request body contains.
const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    price: z.number().positive().max(100000),
    availability: z.boolean(),
    featured: z.boolean(),
    ingredients: z.array(z.string().trim().min(1).max(60)).max(30),
    allergens: z.array(z.string().trim().min(1).max(60)).max(30).nullable(),
    dietaryTags: z.array(z.string().trim().min(1).max(40)).max(10),
  })
  .partial();

router.get(
  "/products",
  asyncHandler(async (req, res) => {
    res.json({ products: getAllProducts({ includeUnavailable: true }) });
  })
);

router.put(
  "/products/:id",
  validateBody(productUpdateSchema),
  asyncHandler(async (req, res) => {
    const existing = getProductById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Product not found." });
    const updated = setProduct(req.params.id, req.body);
    res.json({ product: updated });
  })
);

/**
 * Manually re-fetch the catalog from its active backend. Only meaningful
 * when Google Sheets is active — the sheet is periodically auto-refreshed
 * anyway (see server/products/index.js), but this lets the owner (or their
 * dashboard) pull in a spreadsheet edit immediately instead of waiting for
 * the next timer tick. Against the JSON file backend this is a no-op that
 * still succeeds, since that file is already read fresh on every restart.
 */
router.post(
  "/products/refresh",
  asyncHandler(async (req, res) => {
    try {
      await refreshProducts();
      res.json({ provider: getActiveProviderName(), refreshed: true, productCount: getAllProducts({ includeUnavailable: true }).length });
    } catch (err) {
      res.status(502).json({ error: "Refresh failed.", detail: err.message, provider: getActiveProviderName() });
    }
  })
);

/**
 * Order list for the owner dashboard. Unlike the public order-status
 * endpoint (routes/order.js), this one deliberately DOES include customer
 * name/phone/address — the owner needs that to actually fulfil the order —
 * because this whole router is already gated by adminAuth above.
 */
router.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50)) : 100;
    res.json({ orders: await getAllOrders({ limit }) });
  })
);

router.get(
  "/orders/:id",
  asyncHandler(async (req, res) => {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(404).json({ error: "Order not found." });
    const order = await getOrder(parsed.data);
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order });
  })
);

/**
 * Manually advance an order one step (ORDER_PLACED -> ... -> DELIVERED).
 * This exists because, until Borzo is live, DE.25 handles preparation and
 * delivery themselves — the owner marks progress by hand from the
 * dashboard rather than waiting on a courier webhook that doesn't exist yet.
 * Always moves exactly one step forward; never accepts an arbitrary target
 * status from the client, so a request can't skip or rewind the sequence.
 */
router.put(
  "/orders/:id/advance",
  asyncHandler(async (req, res) => {
    const parsed = idSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(404).json({ error: "Order not found." });
    // An unpaid or cancelled order never enters the kitchen sequence.
    const current = await getOrder(parsed.data);
    if (!current) return res.status(404).json({ error: "Order not found." });
    if (current.status === AWAITING_PAYMENT) return res.status(409).json({ error: "This order hasn't been paid yet." });
    if (current.status === CANCELLED) return res.status(409).json({ error: "This order was cancelled." });
    const order = await advanceStatus(parsed.data);
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order });
  })
);

/**
 * Payments panel: which method is collecting money and what's missing,
 * plus today's totals. Never returns a key secret.
 */
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    res.json({ config: describePaymentConfig(resolvePaymentConfig()), stats: await payments.paymentStats() });
  })
);

/**
 * Recent notifications, for the dashboard's "here's proof it fires" panel.
 * Only meaningful while the demo notification provider is active — once
 * WhatsApp is really connected, messages go straight to WhatsApp instead of
 * this file, so this list will simply stop growing (not error) at that point.
 */
router.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    const provider = getNotificationProvider();
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(NOTIFICATIONS_LOG_PATH, "utf8"));
      if (!Array.isArray(entries)) entries = [];
    } catch (_err) {
      entries = [];
    }
    res.json({ activeProvider: provider.name, entries });
  })
);

/**
 * Borzo panel on the owner dashboard: which delivery provider is active and
 * why, plus the log of real HTTPS exchanges with Borzo (see
 * delivery/borzoActivity.js — only real network calls are ever recorded,
 * never simulated ones). Never returns the token.
 */
router.get(
  "/borzo",
  asyncHandler(async (req, res) => {
    const provider = getDeliveryProvider();
    res.json({
      activeProvider: provider.name,
      config: publicBorzoConfig(resolveBorzoConfig()),
      stats: activityStats(),
      lastSync: lastSync(),
      activity: listActivity({ limit: 60 }),
    });
  })
);

// Each check is two real calls to Borzo; a short cooldown keeps a
// double-click (or a stuck button) from hammering their servers.
const CHECK_COOLDOWN_MS = 5000;
let lastCheckAt = 0;

router.post(
  "/borzo/check",
  asyncHandler(async (req, res) => {
    const wait = lastCheckAt + CHECK_COOLDOWN_MS - Date.now();
    if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)}s before checking again.` });
    lastCheckAt = Date.now();
    res.json(await runConnectionCheck());
  })
);

const sampleOrdersSchema = z.object({ count: z.number().int().min(1).max(5).default(1) });

router.post(
  "/borzo/sample-orders",
  validateBody(sampleOrdersSchema),
  asyncHandler(async (req, res) => {
    try {
      res.status(201).json(await createSampleOrders({ count: req.body.count }));
    } catch (err) {
      if (err instanceof SampleOrdersRefused) return res.status(409).json({ error: err.message });
      throw err;
    }
  })
);

router.post(
  "/borzo/sync",
  asyncHandler(async (req, res) => {
    res.json(await syncBorzoDeliveries());
  })
);

module.exports = router;
