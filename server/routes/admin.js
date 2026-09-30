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
const { getOrder, getAllOrders, advanceStatus } = require("../lib/orders");
const { getNotificationProvider } = require("../notifications");
const { LOG_PATH: NOTIFICATIONS_LOG_PATH } = require("../notifications/DemoNotificationProvider");
const { adminAuth } = require("../middleware/adminAuth");
const { getAdminAuthMode } = require("../lib/adminAuthConfig");
const { validateBody } = require("../lib/validation");
const { asyncHandler } = require("../lib/asyncHandler");

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
    const order = await advanceStatus(parsed.data);
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order });
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

module.exports = router;
