/**
 * Minimal, dependency-free regression tests for the server's safety-critical
 * guarantees: server-authoritative pricing, input validation, and the
 * delivery-provider factory's default-to-demo behavior. These are the
 * properties a real production incident would most likely come from if they
 * silently regressed, so they're covered here rather than left to manual
 * curl checks alone. Run with: npm test
 */
// Set before anything loads server/delivery: the Borzo activity log reads
// its path once at module load, and tests must never write to data/.
process.env.BORZO_ACTIVITY_LOG_PATH = require("path").join(require("os").tmpdir(), `de25-borzo-activity-test-${process.pid}.json`);

const test = require("node:test");
const assert = require("node:assert/strict");

const { priceCart, PricingError } = require("../server/lib/pricing");
const { checkoutSchema, cartItemSchema } = require("../server/lib/validation");
const { getDeliveryProvider, _resetProviderCache } = require("../server/delivery");
const { getAllProducts } = require("../server/lib/datastore");
const productsFactory = require("../server/products");
const ordersFactory = require("../server/orders");
const { getAdminAuthMode } = require("../server/lib/adminAuthConfig");

const PAYMENT_ENV_KEYS = [
  "PAYMENT_PROVIDER",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "PAYMENT_WINDOW_MINUTES",
];
/** Runs fn with exactly `vars` set among the payment env keys, then restores them. */
async function withPaymentEnv(vars, fn) {
  const saved = Object.fromEntries(PAYMENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PAYMENT_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of PAYMENT_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

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
  assert.equal(order.status, "AWAITING_PAYMENT", "an order is never confirmed before it is paid");

  const fetched = await ordersFactory.getOrder(order.orderId);
  assert.equal(fetched.orderId, order.orderId);

  assert.equal((await ordersFactory.advanceStatus(order.orderId)).status, "AWAITING_PAYMENT", "an unpaid order can't be advanced");

  const paid = await ordersFactory.setPayment(order.orderId, { method: "demo", status: "paid" }, { status: "PAYMENT_CONFIRMED", onlyIfStatus: "AWAITING_PAYMENT" });
  assert.equal(paid.status, "PAYMENT_CONFIRMED");
  assert.equal(
    await ordersFactory.setPayment(order.orderId, { method: "demo", status: "paid" }, { status: "PAYMENT_CONFIRMED", onlyIfStatus: "AWAITING_PAYMENT" }),
    null,
    "the compare-and-set lets a payment confirm an order only once"
  );

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
  // Whatever .env says about payments, this test runs in demo mode — it must never reach Razorpay.
  const prevPaymentEnv = Object.fromEntries(PAYMENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PAYMENT_ENV_KEYS) delete process.env[k];
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
    assert.equal(placed.body.status, "AWAITING_PAYMENT");
    assert.equal(placed.body.payment.method, "demo");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(placed.body.orderId).length, 0, "nothing is sent for an order that isn't paid yet");
    const simulated = await call("POST", `/api/payments/${placed.body.orderId}/demo/simulate`);
    assert.equal(simulated.status, 200);
    assert.equal(simulated.body.status, "PAYMENT_CONFIRMED");
    assert.equal(simulated.body.payment.simulated, true);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(placed.body.orderId).length, 1, "verified customer gets their receipt");

    // Production with no WhatsApp account: codes can't be sent (and must never be echoed back);
    // ordering still works, but no customer receipt is sent to the unverified number.
    process.env.NODE_ENV = "production";
    assert.equal((await call("POST", "/api/verify/phone/request", { phone: P2 })).status, 503);
    // ...and with no real payment method set up, production takes no orders at all.
    await withPaymentEnv({}, async () => {
      const refused = await call("POST", "/api/checkout", order(P2));
      assert.equal(refused.status, 503, "production never takes unpaid or fake-paid orders");
    });
    await withRazorpay(stubRazorpay(), async () => {
      const prodOrder = await call("POST", "/api/checkout", order(P2));
      assert.equal(prodOrder.status, 201);
      assert.equal(prodOrder.body.payment.method, "razorpay");
      assert.equal((await call("POST", `/api/payments/${prodOrder.body.orderId}/demo/simulate`)).status, 403, "no simulated payments in production");
      const gatewayOrderId = prodOrder.body.payment.gatewayOrderId;
      const paymentId = `pay_STUB${gatewayOrderId.slice(-12)}`;
      const paid = await require("../server/payments").verifyRazorpayCheckout(prodOrder.body.orderId, {
        razorpay_order_id: gatewayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: hmac(RZP.RAZORPAY_KEY_SECRET, `${gatewayOrderId}|${paymentId}`),
      });
      await paid.deliveryPromise;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(slipsFor(prodOrder.body.orderId).length, 0, "unverified number must not get a receipt");
    });
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    for (const k of PAYMENT_ENV_KEYS) if (prevPaymentEnv[k] !== undefined) process.env[k] = prevPaymentEnv[k];
    server.close();
  }
});

// ---------------------------------------------------------------- Borzo ---
// Everything below talks to a stub fetch — the suite never calls Borzo.

const { HOSTS, LIVE_CONFIRM_PHRASE } = require("../server/delivery/borzoConfig");
const { BorzoDeliveryProvider, BorzoApiError, normalizePhone, mapBorzoStatus } = require("../server/delivery/BorzoDeliveryProvider");
const borzoActivity = require("../server/delivery/borzoActivity");
const { runConnectionCheck } = require("../server/delivery/borzoConnectionCheck");
const { createSampleOrders, SampleOrdersRefused } = require("../server/lib/sampleOrders");
const { ownerMessage, customerSlipMessage } = require("../server/notifications/messages");

const BORZO_ENV_KEYS = [
  "BORZO_DELIVERY_ENABLED",
  "BORZO_AUTH_TOKEN",
  "BORZO_API_KEY",
  "BORZO_ENV",
  "BORZO_LIVE_CONFIRM",
  "PICKUP_ADDRESS",
  "PICKUP_PHONE",
];
const FAKE_TOKEN = "stub-token-never-sent-anywhere";
const FULL_BORZO = {
  BORZO_DELIVERY_ENABLED: "true",
  BORZO_AUTH_TOKEN: FAKE_TOKEN,
  PICKUP_ADDRESS: "Ghansoli, Navi Mumbai, Maharashtra 400701",
  PICKUP_PHONE: "9000000000",
};

/** Runs fn with exactly `vars` set among the Borzo env keys, then restores them. */
async function withBorzoEnv(vars, fn) {
  const saved = Object.fromEntries(BORZO_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of BORZO_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  _resetProviderCache();
  try {
    return await fn();
  } finally {
    for (const k of BORZO_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetProviderCache();
  }
}

/** A fetch stand-in: records every call and answers with handler(url, init) -> { status, json }. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, json } = handler(u, init);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return { impl, calls };
}

function stubProvider(handler) {
  const { impl, calls } = stubFetch(handler);
  const provider = new BorzoDeliveryProvider({
    token: FAKE_TOKEN,
    environment: "test",
    pickup: { name: "DE.25", address: FULL_BORZO.PICKUP_ADDRESS, phone: FULL_BORZO.PICKUP_PHONE },
    fetchImpl: impl,
  });
  return { provider, calls };
}

const DROP = { house: "Flat 4", street: "Palm Beach Road", area: "Vashi", city: "Navi Mumbai", pincode: "400703" };

test("borzo factory: fully configured -> Borzo sandbox by default, never production", async () => {
  await withBorzoEnv(FULL_BORZO, () => {
    const provider = getDeliveryProvider();
    assert.equal(provider.name, "borzo");
    assert.equal(provider.environment, "test");
    assert.ok(provider.baseUrl.startsWith(HOSTS.test));
  });
});

test("borzo factory: BORZO_ENV=production without the confirm phrase stays on demo", async () => {
  await withBorzoEnv({ ...FULL_BORZO, BORZO_ENV: "production", BORZO_LIVE_CONFIRM: "yes" }, () => {
    assert.equal(getDeliveryProvider().name, "demo");
  });
  await withBorzoEnv({ ...FULL_BORZO, BORZO_ENV: "production", BORZO_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE }, () => {
    const provider = getDeliveryProvider();
    assert.equal(provider.name, "borzo");
    assert.equal(provider.environment, "production");
  });
});

test("borzo factory: a token without PICKUP_PHONE stays on demo", async () => {
  await withBorzoEnv({ ...FULL_BORZO, PICKUP_PHONE: "" }, () => {
    assert.equal(getDeliveryProvider().name, "demo");
  });
});

test("borzo: normalizePhone produces +91 numbers", () => {
  assert.equal(normalizePhone("98765 43210"), "+919876543210");
  assert.equal(normalizePhone("919876543210"), "+919876543210");
  assert.equal(normalizePhone("09876543210"), "+919876543210");
  assert.equal(normalizePhone(""), "");
});

test("borzo: mapBorzoStatus only reports what the courier has actually done", () => {
  const visited = { courier_visit_datetime: "2026-10-03T10:00:00+05:30" };
  assert.equal(mapBorzoStatus({ status: "new", points: [{}, {}] }), "searching");
  assert.equal(mapBorzoStatus({ status: "active", points: [{}, {}] }), "courier_assigned");
  assert.equal(mapBorzoStatus({ status: "active", points: [visited, {}] }), "picked_up");
  assert.equal(mapBorzoStatus({ status: "active", points: [visited, { ...visited }] }), "delivered");
  assert.equal(mapBorzoStatus({ status: "completed", points: [] }), "delivered");
  assert.equal(mapBorzoStatus({ status: "canceled", points: [] }), "cancelled");
});

test("borzo provider: quote hits the sandbox host with the token and parses string money", async () => {
  const { provider, calls } = stubProvider(() => ({ json: { is_successful: true, order: { payment_amount: "85.00", points: [] } } }));
  const quote = await provider.getDeliveryQuote(DROP);
  assert.equal(quote.feeRupees, 85);
  assert.equal(quote.isLive, true);
  assert.equal(quote.environment, "test");
  assert.equal(calls[0].url.origin, HOSTS.test);
  assert.equal(calls[0].url.pathname, "/api/business/1.8/calculate-order");
  assert.equal(calls[0].headers["X-DV-Auth-Token"], FAKE_TOKEN);
});

test("borzo provider: create-order returns Borzo's id and tracking page; samples use the shop's phone", async () => {
  const tracking = "https://robotapitest-in.borzodelivery.com/in/tracking/abc123";
  const { provider, calls } = stubProvider(() => ({
    json: { is_successful: true, order: { order_id: 123456, status: "new", payment_amount: "92.00", points: [{}, { tracking_url: tracking }] } },
  }));
  const d = await provider.createDeliveryOrder({
    orderId: "0b8f5c1e-1111-2222-3333-444455556666",
    token: "AB12",
    address: DROP,
    customer: { name: "Stranger", phone: "9876543210" },
    lines: [{ qty: 1, name: "Chocolate Truffle" }],
    isSample: true,
  });
  assert.equal(d.deliveryOrderId, "123456");
  assert.equal(d.trackingUrl, tracking);
  assert.equal(d.status, "searching");
  assert.equal(d.feeRupees, 92);

  const sent = calls[0].body;
  assert.equal(calls[0].url.pathname, "/api/business/1.8/create-order");
  assert.equal(sent.points[1].contact_person.phone, "+919000000000", "a sample must never give a courier a stranger's number");
  assert.equal(sent.is_client_notification_enabled, false);
  assert.equal(sent.is_contact_person_notification_enabled, false);
  assert.equal(sent.points[1].client_order_id.length, 32);
});

test("borzo provider: is_successful:false becomes a BorzoApiError with a customer-safe address message", async () => {
  const { provider } = stubProvider(() => ({
    status: 400,
    json: { is_successful: false, errors: ["invalid_parameters"], parameter_errors: { points: [null, { address: ["invalid_value"] }] } },
  }));
  await assert.rejects(provider.getDeliveryQuote(DROP), (err) => {
    assert.ok(err instanceof BorzoApiError);
    assert.match(err.publicMessage, /couldn't arrange delivery to that address/);
    return true;
  });
});

test("borzo provider: create-order is never retried, even on a 503", async () => {
  const { provider, calls } = stubProvider(() => ({ status: 503, json: { is_successful: false, errors: ["unexpected_error"] } }));
  await assert.rejects(provider.createDeliveryOrder({ orderId: "x", address: DROP, customer: { name: "A", phone: "9876543210" }, lines: [] }));
  assert.equal(calls.length, 1, "a retried create-order could book a second courier");
});

test("borzo activity log never stores the token and masks phone numbers", () => {
  const all = JSON.stringify(borzoActivity.listActivity({ limit: 300 }));
  assert.ok(all.length > 2, "the provider tests above should have logged calls");
  assert.ok(!all.includes(FAKE_TOKEN), "token leaked into the activity log");
  assert.ok(!all.includes("9876543210"), "unmasked customer phone in the activity log");
  assert.ok(!all.includes("9000000000"), "unmasked pickup phone in the activity log");
});

test("borzo connection check: an unauthenticated 400 still proves both hosts are reachable", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 400, json: { is_successful: false, errors: ["required_auth_token"] } }));
  const result = await runConnectionCheck({ env: {}, fetchImpl: impl });
  assert.equal(result.hasToken, false);
  assert.deepEqual(result.hosts.map((h) => h.environment), ["test", "production"]);
  for (const h of result.hosts) {
    assert.equal(h.reachable, true);
    assert.equal(h.authenticated, false);
    assert.equal(h.httpStatus, 400);
    assert.match(h.verdict, /enforcing authentication/);
  }
  assert.ok(calls.every((c) => !("X-DV-Auth-Token" in c.headers)));
});

test("borzo connection check: the token only ever goes to the configured environment's host", async () => {
  const { impl, calls } = stubFetch(() => ({ json: { is_successful: true, order: { payment_amount: "70.00" } } }));
  await runConnectionCheck({ env: { ...FULL_BORZO }, fetchImpl: impl });
  const prod = calls.find((c) => c.url.origin === HOSTS.production);
  const sandbox = calls.find((c) => c.url.origin === HOSTS.test);
  assert.equal(sandbox.headers["X-DV-Auth-Token"], FAKE_TOKEN);
  assert.ok(!("X-DV-Auth-Token" in prod.headers), "a sandbox token must never be sent to production");
});

test("sample orders are refused on Borzo production", async () => {
  await withBorzoEnv({ ...FULL_BORZO, BORZO_ENV: "production", BORZO_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE }, async () => {
    await assert.rejects(createSampleOrders({ count: 1 }), SampleOrdersRefused);
  });
});

test("notifications label samples and never promise a rider for a sandbox booking", () => {
  const order = {
    token: "AB12",
    total: 650,
    isSample: true,
    customer: { name: "Sample - Priya", phone: "9000000101" },
    address: { house: "1", street: "Sector 5", area: "Ghansoli", city: "Navi Mumbai", pincode: "400701" },
    lines: [{ qty: 1, name: "Cake", lineTotal: 650 }],
    deliveryQuote: { isLive: true, environment: "test", feeRupees: 85 },
  };
  assert.match(ownerMessage(order), /^\[SAMPLE - not a real customer\]/);
  assert.match(ownerMessage(order), /Borzo sandbox test booking \(Rs 85\) - no rider will come/);
  assert.match(customerSlipMessage(order), /DE\.25 is preparing and delivering this order directly/);
});

// ------------------------------------------------------------- Payments ---
// Razorpay is always a stub here — the suite never calls Razorpay — and
// delivery is forced to the demo provider so no courier is ever booked.

const crypto = require("crypto");
const payments = require("../server/payments");
const { createPendingOrder } = require("../server/lib/placeOrder");
const { verifyCheckoutSignature, verifyWebhookSignature, RazorpayApiError } = require("../server/payments/RazorpayClient");
const { resolvePaymentConfig, describePaymentConfig } = require("../server/payments/paymentConfig");
const { paymentCspSources } = require("../server/middleware/security");
const { paymentLine } = require("../server/notifications/messages");

const RZP = {
  RAZORPAY_KEY_ID: "rzp_test_STUBKEY123456",
  RAZORPAY_KEY_SECRET: "stub-key-secret-never-sent",
  RAZORPAY_WEBHOOK_SECRET: "stub-webhook-secret",
};
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

async function pendingOrder(method, { windowMinutes = 30 } = {}) {
  const product = getAllProducts().find((p) => !p.variants && p.availability !== false);
  const { order } = await createPendingOrder({
    customer: { name: "Payment Test", phone: "9000000201" },
    address: { house: "1", street: "Sector 5", area: "Ghansoli", city: "Navi Mumbai", pincode: "400701" },
    items: [{ productId: product.productId, qty: 1 }],
    paymentMethod: method,
    windowMinutes,
  });
  return order;
}

/** A RazorpayClient stand-in. `list(gatewayOrderId)` answers GET /orders/:id/payments. */
function stubRazorpay({ list = () => [], failCreate = false } = {}) {
  const calls = [];
  const orders = new Map();
  return {
    calls,
    orders,
    async createOrder({ amountPaise, receipt, notes }) {
      calls.push({ op: "createOrder", amountPaise, receipt, notes });
      if (failCreate) throw new Error("stub: Razorpay is down");
      const id = `order_STUB${crypto.randomBytes(6).toString("hex")}`;
      orders.set(id, amountPaise);
      return { id, amount: amountPaise, currency: "INR", status: "created" };
    },
    async fetchPayment(id) {
      calls.push({ op: "fetchPayment", id });
      const [gatewayOrderId, amount] = [...orders.entries()].find(([g]) => id.endsWith(g.slice(-12))) || [];
      return { id, order_id: gatewayOrderId, amount, status: "authorized", method: "upi" };
    },
    async capturePayment(id, amountPaise) {
      calls.push({ op: "capture", id, amountPaise });
      const p = await this.fetchPayment(id);
      return { ...p, status: "captured" };
    },
    async listOrderPayments(gatewayOrderId) {
      calls.push({ op: "list", gatewayOrderId });
      return list(gatewayOrderId);
    },
  };
}

/** Razorpay env + stub client + demo delivery for the duration of fn. */
async function withRazorpay(stub, fn, vars = RZP) {
  payments._setRazorpayClientForTests(stub);
  try {
    return await withBorzoEnv({}, () => withPaymentEnv(vars, fn));
  } finally {
    payments._setRazorpayClientForTests(null);
  }
}

test("payments config: auto-detects, never falls back from a forced choice, and refuses demo in production", () => {
  assert.equal(resolvePaymentConfig({}).method, "demo");
  const prod = resolvePaymentConfig({ NODE_ENV: "production" });
  assert.equal(prod.method, null, "production with nothing set up takes no orders");
  assert.ok(prod.problems.length);
  assert.equal(resolvePaymentConfig({ PAYMENT_PROVIDER: "razorpay" }).method, null, "a broken forced choice never silently becomes demo");
  assert.equal(resolvePaymentConfig({ ...RZP }).method, "razorpay");
  assert.equal(resolvePaymentConfig({ ...RZP }).razorpay.mode, "test");
  assert.equal(resolvePaymentConfig({ RAZORPAY_KEY_ID: "rzp_live_ABCDEF123456", RAZORPAY_KEY_SECRET: "x" }).razorpay.mode, "live");
  const typo = resolvePaymentConfig({ RAZORPAY_KEY_ID: "not-a-key", RAZORPAY_KEY_SECRET: "x" });
  assert.equal(typo.method, "demo");
  assert.match(typo.problems.join(" "), /RAZORPAY_KEY_ID/, "a mistyped key is reported, not ignored");
  const retired = resolvePaymentConfig({ PAYMENT_PROVIDER: "upi", NODE_ENV: "production" });
  assert.equal(retired.method, null, "the retired direct-UPI mode never takes orders");
  assert.match(retired.problems.join(" "), /PAYMENT_PROVIDER="upi"/);
  const shown = JSON.stringify(describePaymentConfig(resolvePaymentConfig({ ...RZP })));
  assert.ok(!shown.includes(RZP.RAZORPAY_KEY_SECRET) && !shown.includes(RZP.RAZORPAY_WEBHOOK_SECRET), "the dashboard view never carries a secret");
});

test("razorpay: checkout and webhook signatures are checked with HMAC-SHA256", () => {
  const keySecret = RZP.RAZORPAY_KEY_SECRET;
  const signature = hmac(keySecret, "order_ABC|pay_XYZ");
  assert.equal(verifyCheckoutSignature({ gatewayOrderId: "order_ABC", paymentId: "pay_XYZ", signature, keySecret }), true);
  assert.equal(verifyCheckoutSignature({ gatewayOrderId: "order_ABC", paymentId: "pay_OTHER", signature, keySecret }), false);
  assert.equal(verifyCheckoutSignature({ gatewayOrderId: "order_ABC", paymentId: "pay_XYZ", signature: "nope", keySecret }), false);
  const body = Buffer.from('{"event":"payment.captured"}');
  const webhookSecret = RZP.RAZORPAY_WEBHOOK_SECRET;
  assert.equal(verifyWebhookSignature({ rawBody: body, signature: hmac(webhookSecret, body), webhookSecret }), true);
  assert.equal(verifyWebhookSignature({ rawBody: Buffer.from('{"event":"payment.captured" }'), signature: hmac(webhookSecret, body), webhookSecret }), false);
});

test("razorpay: amount fixed server-side, paid only with a valid signature, exactly once, then captured", async () => {
  const stub = stubRazorpay();
  await withRazorpay(stub, async () => {
    const order = await pendingOrder("razorpay");
    assert.equal(order.status, "AWAITING_PAYMENT");
    const start = await payments.startPayment(order, resolvePaymentConfig());
    assert.equal(stub.calls[0].amountPaise, Math.round(order.total * 100), "Razorpay is asked for the server's price");
    assert.equal(start.keyId, RZP.RAZORPAY_KEY_ID);
    assert.equal(start.mode, "test");
    assert.ok(!JSON.stringify(start).includes(RZP.RAZORPAY_KEY_SECRET), "the key secret never reaches the browser");

    const paymentId = `pay_STUB${start.gatewayOrderId.slice(-12)}`;
    const good = hmac(RZP.RAZORPAY_KEY_SECRET, `${start.gatewayOrderId}|${paymentId}`);
    const callback = { razorpay_order_id: start.gatewayOrderId, razorpay_payment_id: paymentId, razorpay_signature: good };

    await assert.rejects(payments.verifyRazorpayCheckout(order.orderId, { ...callback, razorpay_signature: hmac("wrong-secret", "x") }), (e) => e.statusCode === 400);
    await assert.rejects(payments.verifyRazorpayCheckout(order.orderId, { ...callback, razorpay_order_id: "order_SOMEONEELSE" }), (e) => e.statusCode === 400);
    assert.equal((await ordersFactory.getOrder(order.orderId)).status, "AWAITING_PAYMENT", "a forged callback changes nothing");

    const paid = await payments.verifyRazorpayCheckout(order.orderId, callback);
    assert.equal(paid.order.status, "PAYMENT_CONFIRMED");
    assert.equal(paid.order.payment.verifiedBy, "razorpay-signature");
    await paid.deliveryPromise;
    const again = await payments.verifyRazorpayCheckout(order.orderId, callback);
    assert.equal(again.alreadySettled, true, "a repeated callback never dispatches twice");

    assert.equal(await payments.ensureCaptured(order.orderId), "captured");
    assert.ok(stub.calls.some((c) => c.op === "capture" && c.amountPaise === order.payment.amountPaise), "an authorized payment is captured for the exact amount");
    const settled = await ordersFactory.getOrder(order.orderId);
    assert.equal(settled.payment.gatewayStatus, "captured");
    assert.equal(settled.payment.anomaly, null);
  });
});

test("razorpay: a gateway failure cancels the order; expiry asks Razorpay before cancelling", async () => {
  await withRazorpay(stubRazorpay({ failCreate: true }), async () => {
    const order = await pendingOrder("razorpay");
    await assert.rejects(payments.startPayment(order, resolvePaymentConfig()), (e) => e.statusCode === 502);
    const after = await ordersFactory.getOrder(order.orderId);
    assert.equal(after.status, "CANCELLED", "no order is left dangling without a way to pay");
    assert.equal(after.payment.status, "failed");
  });

  let paidGatewayId = null;
  let unreachableGatewayId = null;
  const stub = stubRazorpay({
    list: (gid) => {
      if (gid === unreachableGatewayId) throw new Error("stub: network down");
      return gid === paidGatewayId ? [{ id: `pay_STUB${gid.slice(-12)}`, status: "captured", amount: stub.orders.get(gid), method: "card" }] : [];
    },
  });
  await withRazorpay(stub, async () => {
    const paidLate = await pendingOrder("razorpay", { windowMinutes: -1 });
    const neverPaid = await pendingOrder("razorpay", { windowMinutes: -1 });
    const unreachable = await pendingOrder("razorpay", { windowMinutes: -1 });
    paidGatewayId = (await payments.startPayment(paidLate, resolvePaymentConfig())).gatewayOrderId;
    await payments.startPayment(neverPaid, resolvePaymentConfig());
    unreachableGatewayId = (await payments.startPayment(unreachable, resolvePaymentConfig())).gatewayOrderId;

    const summary = await payments.expireStalePayments();
    assert.ok(summary.reconciled >= 1 && summary.expired >= 1);
    const a = await ordersFactory.getOrder(paidLate.orderId);
    assert.equal(a.status, "PAYMENT_CONFIRMED", "a payment whose callback never arrived is honoured, not cancelled");
    assert.equal(a.payment.verifiedBy, "razorpay-api");
    const b = await ordersFactory.getOrder(neverPaid.orderId);
    assert.equal(b.status, "CANCELLED");
    assert.equal(b.payment.status, "expired");
    assert.equal((await ordersFactory.getOrder(unreachable.orderId)).status, "AWAITING_PAYMENT", "if Razorpay can't be reached, wait — don't cancel a maybe-paid order");
  });
});

test("razorpay webhook over HTTP: raw-body signature, honours a late payment, ignores a wrong amount", async () => {
  const stub = stubRazorpay();
  const { app } = require("../server/index.js");
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/payments/razorpay/webhook`;
  const post = async (event, secret = RZP.RAZORPAY_WEBHOOK_SECRET) => {
    const body = JSON.stringify(event);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": hmac(secret, body) }, body });
    return { status: res.status, body: await res.json() };
  };
  const captured = (order, gatewayOrderId, amount) => ({
    event: "payment.captured",
    payload: { payment: { entity: { id: `pay_WH${gatewayOrderId.slice(-10)}`, order_id: gatewayOrderId, amount, status: "captured", method: "upi", notes: { de25_order_id: order.orderId } } } },
  });
  try {
    await withRazorpay(stub, async () => {
      const late = await pendingOrder("razorpay", { windowMinutes: -1 });
      const lateGid = (await payments.startPayment(late, resolvePaymentConfig())).gatewayOrderId;
      await payments.expireStalePayments();
      assert.equal((await ordersFactory.getOrder(late.orderId)).status, "CANCELLED");

      assert.equal((await post(captured(late, lateGid, late.payment.amountPaise), "forged-secret")).status, 400, "unsigned webhooks are refused");
      assert.equal((await ordersFactory.getOrder(late.orderId)).status, "CANCELLED");

      const ok = await post(captured(late, lateGid, late.payment.amountPaise));
      assert.equal(ok.status, 200);
      const honoured = await ordersFactory.getOrder(late.orderId);
      assert.equal(honoured.status, "PAYMENT_CONFIRMED", "money that arrived after the window still gets the customer their order");
      assert.equal(honoured.payment.paidAfterExpiry, true);
      assert.equal(honoured.payment.verifiedBy, "razorpay-webhook");

      const other = await pendingOrder("razorpay");
      const otherGid = (await payments.startPayment(other, resolvePaymentConfig())).gatewayOrderId;
      assert.equal((await post(captured(other, otherGid, 100))).status, 200);
      assert.equal((await ordersFactory.getOrder(other.orderId)).status, "AWAITING_PAYMENT", "a payment for the wrong amount never confirms an order");
    });
    await withRazorpay(
      stub,
      async () => {
        assert.equal((await post({ event: "payment.captured" })).status, 503, "no webhook secret, no webhook");
      },
      { RAZORPAY_KEY_ID: RZP.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: RZP.RAZORPAY_KEY_SECRET }
    );
  } finally {
    server.close();
  }
});

test("razorpay: a paid order confirms itself within one sweep — no webhook, no callback, nobody pressing a button", async () => {
  await withPaymentEnv({}, async () => {
    assert.deepEqual(await payments.reconcilePendingPayments(), { checked: 0, reconciled: 0 }, "without Razorpay keys nothing is asked");
  });

  let paidGatewayIds = new Set();
  let failedGatewayId = null;
  let unknownGatewayId = null;
  const stub = stubRazorpay({
    list: (gid) => {
      if (gid === unknownGatewayId) throw new RazorpayApiError("Razorpay HTTP 404", { httpStatus: 404 });
      if (paidGatewayIds.has(gid)) return [{ id: `pay_STUB${gid.slice(-12)}`, status: "captured", amount: stub.orders.get(gid), method: "upi" }];
      if (gid === failedGatewayId) return [{ id: `pay_FAIL${gid.slice(-12)}`, status: "failed", amount: stub.orders.get(gid), error_code: "BAD_REQUEST_ERROR", error_description: "Payment was declined by the bank" }];
      return [];
    },
  });
  await withRazorpay(stub, async () => {
    const scanned = await pendingOrder("razorpay");
    const waiting = await pendingOrder("razorpay");
    const declined = await pendingOrder("razorpay");
    const stale = await pendingOrder("razorpay", { windowMinutes: -1 });
    const orphan = await pendingOrder("razorpay", { windowMinutes: -1 });
    unknownGatewayId = (await payments.startPayment(orphan, resolvePaymentConfig())).gatewayOrderId;
    const scannedGid = (await payments.startPayment(scanned, resolvePaymentConfig())).gatewayOrderId;
    await payments.startPayment(waiting, resolvePaymentConfig());
    failedGatewayId = (await payments.startPayment(declined, resolvePaymentConfig())).gatewayOrderId;
    const staleGid = (await payments.startPayment(stale, resolvePaymentConfig())).gatewayOrderId;
    paidGatewayIds = new Set([scannedGid, staleGid]);

    const summary = await payments.reconcilePendingPayments();
    assert.ok(summary.checked >= 3 && summary.reconciled >= 1);
    const a = await ordersFactory.getOrder(scanned.orderId);
    assert.equal(a.status, "PAYMENT_CONFIRMED", "a QR payment whose browser callback never arrived still confirms the order");
    assert.equal(a.payment.verifiedBy, "razorpay-api");
    assert.equal((await ordersFactory.getOrder(waiting.orderId)).status, "AWAITING_PAYMENT", "nothing paid, nothing confirmed");
    const d = await ordersFactory.getOrder(declined.orderId);
    assert.equal(d.status, "AWAITING_PAYMENT", "a declined attempt leaves the customer free to try again");
    assert.match(d.payment.lastError.description, /declined/);
    assert.equal((await ordersFactory.getOrder(stale.orderId)).status, "AWAITING_PAYMENT", "orders past their window are left to the expiry check");

    const again = await payments.reconcilePendingPayments();
    assert.equal((await ordersFactory.getOrder(scanned.orderId)).payment.paymentId, a.payment.paymentId, "a second sweep never pays an order twice");
    assert.ok(again.checked >= 2);
    await payments.expireStalePayments();
    assert.equal((await ordersFactory.getOrder(stale.orderId)).status, "PAYMENT_CONFIRMED", "...which still asks Razorpay before cancelling");
    assert.equal((await ordersFactory.getOrder(orphan.orderId)).status, "CANCELLED", "an order Razorpay has never heard of (other keys) expires instead of waiting forever");
  });
});

test("admin: unpaid orders can't be advanced or confirmed by hand; payments panel shows no secrets", async () => {
  const { app } = require("../server/index.js");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  clearAdminAuthEnv();
  const adminToken = crypto.randomBytes(24).toString("hex");
  process.env.ADMIN_TOKEN = adminToken;
  const call = async (method, path) => {
    const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${adminToken}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await withBorzoEnv({}, () =>
      withPaymentEnv({ RAZORPAY_KEY_SECRET: "half-configured-secret" }, async () => {
        const order = await pendingOrder("demo");
        assert.equal((await call("PUT", `/orders/${order.orderId}/advance`)).status, 409, "an unpaid order never reaches the kitchen");
        assert.equal((await call("PUT", `/orders/${order.orderId}/payment/confirm`)).status, 404, "there is no 'mark as paid' button to press");
        assert.equal((await ordersFactory.getOrder(order.orderId)).status, "AWAITING_PAYMENT");
        await (await payments.simulateDemoPayment(order.orderId)).deliveryPromise;
        assert.equal((await call("PUT", `/orders/${order.orderId}/advance`)).body.order.status, "PREPARING");

        const panel = await call("GET", "/payments");
        assert.equal(panel.status, 200);
        assert.equal(panel.body.config.method, "demo");
        assert.match(panel.body.config.problems.join(" "), /RAZORPAY_KEY_ID/, "a half-set-up Razorpay is flagged to the owner");
        assert.ok(!JSON.stringify(panel.body).includes("half-configured-secret"));
        assert.equal(typeof panel.body.stats.awaiting, "number");
      })
    );
  } finally {
    clearAdminAuthEnv();
    server.close();
  }
});

test("csp: Razorpay's checkout script and frame are allowed only when Razorpay is the active method", () => {
  assert.deepEqual(paymentCspSources("upi"), {});
  assert.deepEqual(paymentCspSources("demo"), {});
  const rzp = paymentCspSources("razorpay");
  for (const directive of ["scriptSrc", "frameSrc", "imgSrc", "connectSrc"]) {
    assert.deepEqual(rzp[directive], ["https://*.razorpay.com"], `${directive} allows Razorpay's own hosts and nothing else`);
  }
});

test("notifications say exactly how an order was paid — test and simulated money never look real", () => {
  assert.equal(paymentLine({ isSample: true, payment: { method: "sample", simulated: true } }), "Payment: none (sample order)");
  assert.match(paymentLine({ payment: { method: "demo", simulated: true } }), /SIMULATED/);
  assert.match(paymentLine({ payment: { method: "razorpay", mode: "test", paymentId: "pay_1" } }), /TEST MODE - no real money.*pay_1/);
  assert.doesNotMatch(paymentLine({ payment: { method: "razorpay", mode: "live", paymentId: "pay_1" } }), /TEST/);
});
