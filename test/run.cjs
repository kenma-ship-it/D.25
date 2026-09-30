/**
 * Minimal, dependency-free regression tests for the server's safety-critical
 * guarantees: server-authoritative pricing, input validation, and the
 * delivery-provider factory's default-to-demo behavior. These are the
 * properties a real production incident would most likely come from if they
 * silently regressed, so they're covered here rather than left to manual
 * curl checks alone. Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { priceCart, PricingError } = require("../server/lib/pricing");
const { checkoutSchema, cartItemSchema } = require("../server/lib/validation");
const { getDeliveryProvider, _resetProviderCache } = require("../server/delivery");
const { getAllProducts } = require("../server/lib/datastore");
const productsFactory = require("../server/products");
const ordersFactory = require("../server/orders");
const { getAdminAuthMode } = require("../server/lib/adminAuthConfig");

test("priceCart ignores any client-supplied price and uses the real menu price", () => {
  const products = getAllProducts();
  const first = products.find((p) => !p.variants);
  assert.ok(first, "expected at least one non-variant product in the catalog");

  const result = priceCart([{ productId: first.productId, qty: 1, price: 1 }]);
  assert.equal(result.lines[0].unitPrice, first.price);
  assert.equal(result.subtotal, first.price);
});

test("priceCart rejects a product that doesn't exist", () => {
  assert.throws(() => priceCart([{ productId: "not-a-real-product", qty: 1 }]), PricingError);
});

test("priceCart rejects an empty cart", () => {
  assert.throws(() => priceCart([]), PricingError);
});

test("priceCart rejects a quantity above the per-line maximum", () => {
  const products = getAllProducts();
  assert.throws(() => priceCart([{ productId: products[0].productId, qty: 999 }]), PricingError);
});

test("cartItemSchema accepts variantLabel as null (the frontend's no-variant value)", () => {
  const result = cartItemSchema.safeParse({ productId: "x", qty: 1, variantLabel: null });
  assert.equal(result.success, true);
});

test("checkoutSchema rejects a 9-digit phone number", () => {
  const result = checkoutSchema.safeParse({
    customer: { name: "Test", phone: "123456789" },
    address: { house: "1", street: "a", area: "b", city: "c", pincode: "500032" },
    items: [{ productId: "x", qty: 1 }],
    paymentMethod: "upi",
  });
  assert.equal(result.success, false);
});

test("checkoutSchema rejects a 5-digit pincode", () => {
  const result = checkoutSchema.safeParse({
    customer: { name: "Test", phone: "9876543210" },
    address: { house: "1", street: "a", area: "b", city: "c", pincode: "12345" },
    items: [{ productId: "x", qty: 1 }],
    paymentMethod: "upi",
  });
  assert.equal(result.success, false);
});

test("delivery provider factory defaults to the demo provider when BORZO_DELIVERY_ENABLED is unset", () => {
  delete process.env.BORZO_DELIVERY_ENABLED;
  delete process.env.BORZO_API_KEY;
  _resetProviderCache();
  const provider = getDeliveryProvider();
  assert.equal(provider.name, "demo");
});

test("delivery provider factory stays on demo if BORZO_DELIVERY_ENABLED=true but no API key is set", () => {
  process.env.BORZO_DELIVERY_ENABLED = "true";
  delete process.env.BORZO_API_KEY;
  _resetProviderCache();
  const provider = getDeliveryProvider();
  assert.equal(provider.name, "demo");
  delete process.env.BORZO_DELIVERY_ENABLED;
  _resetProviderCache();
});

test("products provider factory defaults to the JSON file catalog when Sheets is unset", () => {
  delete process.env.GOOGLE_SHEETS_PRODUCTS_ENABLED;
  delete process.env.GOOGLE_SHEETS_ID;
  productsFactory._resetProviderCache();
  assert.equal(productsFactory.getActiveProviderName(), "json-file");
  assert.ok(productsFactory.getAllProducts().length > 0);
});

test("products provider factory stays on the JSON file catalog if Sheets is enabled but not configured", () => {
  process.env.GOOGLE_SHEETS_PRODUCTS_ENABLED = "true";
  delete process.env.GOOGLE_SHEETS_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  productsFactory._resetProviderCache();
  assert.equal(productsFactory.getActiveProviderName(), "json-file");
  delete process.env.GOOGLE_SHEETS_PRODUCTS_ENABLED;
  productsFactory._resetProviderCache();
});

test("order store factory defaults to the JSON file store when Supabase is unset", () => {
  delete process.env.SUPABASE_ORDERS_ENABLED;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  ordersFactory._resetProviderCache();
  assert.equal(ordersFactory.getActiveStoreName(), "json-file");
});

test("order store factory stays on the JSON file store if Supabase is enabled but not configured", () => {
  process.env.SUPABASE_ORDERS_ENABLED = "true";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  ordersFactory._resetProviderCache();
  assert.equal(ordersFactory.getActiveStoreName(), "json-file");
  delete process.env.SUPABASE_ORDERS_ENABLED;
  ordersFactory._resetProviderCache();
});

test("order store round-trips create/get/advance through the active store", async () => {
  ordersFactory._resetProviderCache();
  const order = await ordersFactory.createOrder({
    customer: { name: "Test User", phone: "9876543210" },
    address: { house: "1", street: "Test St", area: "Area", city: "City", pincode: "500001" },
    pricing: {
      lines: [{ productId: "test", name: "Test Item", variantLabel: null, unitPrice: 100, qty: 1, lineTotal: 100 }],
      subtotal: 100,
      deliveryFee: 0,
      tax: 0,
      total: 100,
      deliveryQuote: { provider: "demo", feeRupees: 0, etaMinutes: 30, isLive: false },
    },
    paymentMethod: "upi",
  });
  assert.equal(order.status, "PAYMENT_CONFIRMED");

  const fetched = await ordersFactory.getOrder(order.orderId);
  assert.equal(fetched.orderId, order.orderId);

  const { STATUSES } = require("../server/orders/JsonFileOrdersStore");
  const advanced = await ordersFactory.advanceStatus(order.orderId);
  assert.equal(advanced.status, STATUSES[STATUSES.indexOf("PAYMENT_CONFIRMED") + 1]);
});

test("checkoutSchema rejects cash on delivery — online payment only", () => {
  const base = {
    customer: { name: "Test", phone: "9876543210" },
    address: { house: "1", street: "a", area: "b", city: "c", pincode: "400701" },
    items: [{ productId: "x", qty: 1 }],
  };
  assert.equal(checkoutSchema.safeParse({ ...base, paymentMethod: "cod" }).success, false);
  assert.equal(checkoutSchema.safeParse(base).success, false, "a payment method is required");
  assert.equal(checkoutSchema.safeParse({ ...base, paymentMethod: "upi" }).success, true);
});

test("getOrdersByPhone finds orders for a matching phone number and nothing for a stranger's", async () => {
  ordersFactory._resetProviderCache();
  const pricing = {
    lines: [{ productId: "test", name: "Test Item", variantLabel: null, unitPrice: 100, qty: 1, lineTotal: 100 }],
    subtotal: 100,
    deliveryFee: 0,
    tax: 0,
    total: 100,
    deliveryQuote: { provider: "demo", feeRupees: 0, etaMinutes: 30, isLive: false },
  };
  const address = { house: "1", street: "Test St", area: "Area", city: "City", pincode: "500001" };

  const orderA = await ordersFactory.createOrder({
    customer: { name: "Phone Lookup Tester", phone: "9123456780" },
    address,
    pricing,
    paymentMethod: "upi",
  });
  await ordersFactory.createOrder({
    customer: { name: "Someone Else", phone: "9999999999" },
    address,
    pricing,
    paymentMethod: "upi",
  });

  const mine = await ordersFactory.getOrdersByPhone("9123456780");
  assert.ok(mine.some((o) => o.orderId === orderA.orderId));
  assert.ok(mine.every((o) => o.customer.phone === "9123456780"));

  const strangers = await ordersFactory.getOrdersByPhone("0000000000");
  assert.equal(strangers.length, 0);
});

function clearAdminAuthEnv() {
  delete process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_AUTH_PROVIDER;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_JWT_SECRET;
}

test("admin auth mode is 'none' when nothing is configured", () => {
  clearAdminAuthEnv();
  assert.equal(getAdminAuthMode().mode, "none");
  clearAdminAuthEnv();
});

test("admin auth mode is 'token' when only ADMIN_TOKEN is set", () => {
  clearAdminAuthEnv();
  process.env.ADMIN_TOKEN = "test-secret";
  assert.equal(getAdminAuthMode().mode, "token");
  clearAdminAuthEnv();
});

test("admin auth mode falls back to 'token' when Supabase is requested but not configured", () => {
  clearAdminAuthEnv();
  process.env.ADMIN_TOKEN = "test-secret";
  process.env.ADMIN_AUTH_PROVIDER = "supabase";
  assert.equal(getAdminAuthMode().mode, "token");
  clearAdminAuthEnv();
});

test("admin auth mode is 'supabase' once fully configured", () => {
  clearAdminAuthEnv();
  process.env.ADMIN_AUTH_PROVIDER = "supabase";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_JWT_SECRET = "jwt-secret";
  const result = getAdminAuthMode();
  assert.equal(result.mode, "supabase");
  assert.equal(result.supabaseUrl, "https://example.supabase.co");
  clearAdminAuthEnv();
});

// --- Supabase admin allowlist (security fix: a valid Supabase login from a
// self-signed-up stranger must NOT open the owner dashboard). ---
const jwtLib = require("jsonwebtoken");
const { adminAuth } = require("../server/middleware/adminAuth");

function runAdminAuth(token) {
  let statusCode = 200;
  let nextCalled = false;
  const req = { get: (h) => (h.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined) };
  const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
  adminAuth(req, res, () => { nextCalled = true; });
  return { statusCode, nextCalled };
}

function withSupabaseEnv(adminEmails, fn) {
  clearAdminAuthEnv();
  process.env.ADMIN_AUTH_PROVIDER = "supabase";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_JWT_SECRET = "jwt-secret";
  if (adminEmails !== undefined) process.env.ADMIN_EMAILS = adminEmails;
  try { fn(); } finally { clearAdminAuthEnv(); delete process.env.ADMIN_EMAILS; }
}

const signUser = (email) => jwtLib.sign({ sub: "u1", aud: "authenticated", email }, "jwt-secret", { algorithm: "HS256" });

test("supabase admin: a valid login NOT on ADMIN_EMAILS is refused", () => {
  withSupabaseEnv("owner@de25.in", () => {
    const r = runAdminAuth(signUser("stranger@example.com"));
    assert.equal(r.nextCalled, false);
    assert.equal(r.statusCode, 403);
  });
});

test("supabase admin: an allowlisted email is admitted (case-insensitive)", () => {
  withSupabaseEnv(" Owner@DE25.in , helper@de25.in", () => {
    const r = runAdminAuth(signUser("owner@de25.in"));
    assert.equal(r.nextCalled, true);
  });
});

test("supabase admin: an empty ADMIN_EMAILS admits nobody (fails closed)", () => {
  withSupabaseEnv(undefined, () => {
    const r = runAdminAuth(signUser("owner@de25.in"));
    assert.equal(r.nextCalled, false);
    assert.equal(r.statusCode, 403);
  });
});

// --- WhatsApp phone verification (one-time codes) ---
const pv = require("../server/lib/phoneVerification");

test("otp: correct code yields a token valid only for that phone", () => {
  pv._reset();
  const { code } = pv.issueCode("9000000001", 1000);
  const { token } = pv.confirmCode("9000000001", code, 2000);
  assert.equal(pv.verifyToken(token, "9000000001", 3000), true);
  assert.equal(pv.verifyToken(token, "9000000002", 3000), false, "token must not work for another number");
});

test("otp: a code can only be used once", () => {
  pv._reset();
  const { code } = pv.issueCode("9000000003", 1000);
  pv.confirmCode("9000000003", code, 2000);
  assert.throws(() => pv.confirmCode("9000000003", code, 3000), (e) => e.statusCode === 410);
});

test("otp: wrong codes count down, then lock the code out", () => {
  pv._reset();
  const { code } = pv.issueCode("9000000004", 1000);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let left = pv.MAX_ATTEMPTS - 1; left >= 1; left--) {
    assert.throws(() => pv.confirmCode("9000000004", wrong, 2000), (e) => e.statusCode === 400 && e.attemptsLeft === left);
  }
  assert.throws(() => pv.confirmCode("9000000004", wrong, 2000), (e) => e.statusCode === 429);
  // Even the right code is useless once locked out.
  assert.throws(() => pv.confirmCode("9000000004", code, 2000), (e) => e.statusCode === 410);
});

test("otp: codes expire, and resends are rate-limited", () => {
  pv._reset();
  const { code } = pv.issueCode("9000000005", 1000);
  assert.throws(() => pv.issueCode("9000000005", 1000 + 1000), (e) => e.statusCode === 429);
  assert.throws(() => pv.confirmCode("9000000005", code, 1000 + pv.CODE_TTL_MS + 1), (e) => e.statusCode === 410);
});

test("otp: tokens expire and reject tampering", () => {
  pv._reset();
  const { code } = pv.issueCode("9000000006", 1000);
  const { token } = pv.confirmCode("9000000006", code, 1000);
  assert.equal(pv.verifyToken(token, "9000000006", 1000 + pv.TOKEN_TTL_MS + 1), false);
  const [v, , exp, sig] = token.split(".");
  assert.equal(pv.verifyToken(`${v}.9000000007.${exp}.${sig}`, "9000000007", 2000), false, "swapping the phone must break the signature");
  assert.equal(pv.verifyToken(`${v}.9000000006.${Number(exp) + 999999}.${sig}`, "9000000006", 2000), false, "extending expiry must break the signature");
});

// End-to-end over HTTP against the real Express app (demo WhatsApp provider).
test("otp http: My Orders and checkout both require the WhatsApp code; receipts only go to verified numbers", async () => {
  pv._reset();
  const fs = require("fs");
  const path = require("path");
  const { app } = require("../server/index.js");
  const { initProducts } = require("../server/products");
  await initProducts();
  const notificationsPath = path.join(__dirname, "..", "data", "notifications.json");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const product = getAllProducts().find((p) => !p.variants && p.availability !== false);
  const order = (phone, token) => ({
    customer: { name: "Test Customer", phone },
    address: { house: "12", street: "Main Road", area: "Sector 5", city: "Navi Mumbai", pincode: "400701" },
    items: [{ productId: product.productId, qty: 1 }],
    paymentMethod: "upi",
    ...(token ? { phoneVerificationToken: token } : {}),
  });
  const slipsFor = (orderId) => {
    try { return JSON.parse(fs.readFileSync(notificationsPath, "utf8")).filter((n) => n.orderId === orderId && n.type === "customer_order_slip"); }
    catch { return []; }
  };
  const prevEnv = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    const P1 = "9811111111";
    const P2 = "9822222222";

    assert.equal((await call("GET", `/api/orders/by-phone/${P1}`)).status, 401, "lookup without a code must be refused");

    const req1 = await call("POST", "/api/verify/phone/request", { phone: P1 });
    assert.equal(req1.status, 200);
    assert.match(req1.body.demoCode, /^\d{6}$/);
    assert.equal((await call("POST", "/api/verify/phone/request", { phone: P1 })).status, 429, "instant resend must be throttled");

    const wrong = req1.body.demoCode === "000000" ? "111111" : "000000";
    const bad = await call("POST", "/api/verify/phone/confirm", { phone: P1, code: wrong });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.attemptsLeft, pv.MAX_ATTEMPTS - 1);

    const ok = await call("POST", "/api/verify/phone/confirm", { phone: P1, code: req1.body.demoCode });
    assert.equal(ok.status, 200);
    const token = ok.body.verificationToken;

    assert.equal((await call("GET", `/api/orders/by-phone/${P1}`, null, { "X-Phone-Verification": token })).status, 200);
    assert.equal((await call("GET", `/api/orders/by-phone/${P2}`, null, { "X-Phone-Verification": token })).status, 401, "P1's token must not unlock P2's orders");

    const noToken = await call("POST", "/api/checkout", order(P1));
    assert.equal(noToken.status, 400);
    assert.equal(noToken.body.needsVerification, true);
    assert.equal((await call("POST", "/api/checkout", order(P2, token))).status, 400, "P1's token must not verify an order for P2");

    const placed = await call("POST", "/api/checkout", order(P1, token));
    assert.equal(placed.status, 201);
    assert.equal(placed.body.pin, undefined, "order PIN must not be exposed");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(placed.body.orderId).length, 1, "verified customer gets their receipt");

    // Production with no WhatsApp account: codes can't be sent (and must never be echoed back);
    // ordering still works, but no customer receipt is sent to the unverified number.
    process.env.NODE_ENV = "production";
    assert.equal((await call("POST", "/api/verify/phone/request", { phone: P2 })).status, 503);
    const prodOrder = await call("POST", "/api/checkout", order(P2));
    assert.equal(prodOrder.status, 201);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(prodOrder.body.orderId).length, 0, "unverified number must not get a receipt");
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    server.close();
  }
});
