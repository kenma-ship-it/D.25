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
  assert.equal(order.status, "AWAITING_PAYMENT", "nothing is confirmed before the payment gateway says so");

  const fetched = await ordersFactory.getOrder(order.orderId);
  assert.equal(fetched.orderId, order.orderId);
  await ordersFactory.updateOrder(order.orderId, { status: "PAYMENT_CONFIRMED" });

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
    assert.equal(placed.body.status, "AWAITING_PAYMENT");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(placed.body.orderId).length, 0, "no receipt before payment");
    assert.equal((await call("POST", `/api/payments/${placed.body.orderId}/demo`, { outcome: "success" })).body.order.payment.status, "PAID");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(placed.body.orderId).length, 1, "verified customer gets their receipt once paid");

    // Production with no WhatsApp account: codes can't be sent (and must never be echoed back);
    // ordering still works, but no customer receipt is sent to the unverified number.
    process.env.NODE_ENV = "production";
    assert.equal((await call("POST", "/api/verify/phone/request", { phone: P2 })).status, 503);
    const prodOrder = await call("POST", "/api/checkout", order(P2));
    assert.equal(prodOrder.status, 201);
    await call("POST", `/api/payments/${prodOrder.body.orderId}/demo`, { outcome: "success" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slipsFor(prodOrder.body.orderId).length, 0, "unverified number must not get a receipt");
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
    server.close();
  }
});

// --- QR review page: suggestion engine + API ---
const rv = require("../server/lib/reviewSuggest");

test("review built-in: matches the stars and only names the items picked", () => {
  const five = rv.builtInSuggest({ rating: 5, itemNames: ["Blueberry Cheesecake"], tagLabels: { positive: ["Taste"], issues: [] }, seed: 3 });
  assert.match(five, /Blueberry Cheesecake/);
  assert.match(five, /taste/i);
  for (let seed = 1; seed <= 30; seed++) {
    const one = rv.builtInSuggest({ rating: 1, itemNames: ["Korean Bun"], tagLabels: { positive: [], issues: ["Late delivery"] }, seed });
    assert.doesNotMatch(one, /loved|highly recommend|must-try|gem|delicious/i, "a 1-star draft must not read positive");
    assert.doesNotMatch(one, /Cheesecake|Tiramisu|Brownie/, "must not invent items");
    assert.doesNotMatch(rv.builtInSuggest({ rating: 4, itemNames: ["A", "B"], tagLabels: { positive: [], issues: [] }, seed }), /they was|it were/);
  }
});

test("review grok: sends a Responses API request and reads text past a reasoning item", async () => {
  process.env.XAI_API_KEY = "test-key";
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: '"Loved the Tiramisu at DE.25, super fresh! #dessert ★★★★★"' }] }] }) };
  };
  try {
    const out = await rv.suggestReview({ rating: 5, itemNames: ["Tiramisu"], tagLabels: { positive: ["Freshness"], issues: [] }, seed: 1 }, { fetchImpl: fakeFetch });
    assert.equal(out.engine, "grok");
    assert.equal(out.text, "Loved the Tiramisu at DE.25, super fresh!");
    assert.match(captured.url, /\/v1\/responses$/);
    assert.equal(captured.opts.headers.Authorization, "Bearer test-key");
    assert.ok(captured.body.model);
    assert.match(captured.body.input[0].content, /never sound more positive than the rating/);
    assert.match(captured.body.input[1].content, /Star rating: 5 out of 5[\s\S]*Tiramisu/);
  } finally {
    delete process.env.XAI_API_KEY;
  }
});

test("review grok: any failure falls back to the built-in writer", async () => {
  process.env.XAI_API_KEY = "test-key";
  try {
    const failing = [
      async () => { throw new Error("network down"); },
      async () => ({ ok: false, status: 401, text: async () => "bad key" }),
      async () => ({ ok: true, json: async () => ({ output: [] }) }),
    ];
    for (const f of failing) {
      const out = await rv.suggestReview({ rating: 4, itemNames: ["Korean Bun"], tagLabels: { positive: [], issues: [] }, seed: 2 }, { fetchImpl: f });
      assert.equal(out.engine, "built-in");
      assert.match(out.text, /Korean Bun/);
    }
  } finally {
    delete process.env.XAI_API_KEY;
  }
});

test("review google link: Place ID builds the write-review link; non-Google URLs are ignored", () => {
  const keep = { u: process.env.GOOGLE_REVIEW_URL, p: process.env.GOOGLE_PLACE_ID };
  try {
    delete process.env.GOOGLE_REVIEW_URL;
    delete process.env.GOOGLE_PLACE_ID;
    assert.equal(rv.getGoogleReviewUrl().configured, false);
    process.env.GOOGLE_PLACE_ID = "ChIJN1t_tDeuEmsRUsoyG83frY4";
    assert.equal(rv.getGoogleReviewUrl().url, "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4");
    process.env.GOOGLE_REVIEW_URL = "https://evil.example.com/phish";
    assert.match(rv.getGoogleReviewUrl().url, /^https:\/\/search\.google\.com\//, "a non-Google link must be ignored");
    process.env.GOOGLE_REVIEW_URL = "https://g.page/r/CabcDEF123/review";
    assert.equal(rv.getGoogleReviewUrl().url, "https://g.page/r/CabcDEF123/review");
  } finally {
    if (keep.u === undefined) delete process.env.GOOGLE_REVIEW_URL; else process.env.GOOGLE_REVIEW_URL = keep.u;
    if (keep.p === undefined) delete process.env.GOOGLE_PLACE_ID; else process.env.GOOGLE_PLACE_ID = keep.p;
  }
});

test("review http: validates input, ignores tags that don't fit the rating, serves menu, short link; QR card is owner-only", async () => {
  const { app } = require("../server/index.js");
  await require("../server/products").initProducts();
  delete process.env.XAI_API_KEY; // never call the real Grok API from tests
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const r = await fetch(`${base}/api/review/suggest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  process.env.PUBLIC_SITE_URL = "https://de25.example.in";
  try {
    const menu = await (await fetch(`${base}/api/review/menu`)).json();
    assert.deepEqual(menu.categories.map((c) => c.id), ["cakes", "pastries", "savouries", "sips"]);
    assert.ok(menu.items.some((i) => i.id === "korean-bun" && i.category === "savouries"));
    assert.equal((await post({ items: ["korean-bun"] })).status, 400, "rating required");
    assert.equal((await post({ rating: 6, items: ["korean-bun"] })).status, 400);
    assert.equal((await post({ rating: 5, items: ["not-a-real-item"] })).status, 400, "made-up items rejected");
    const low = await post({ rating: 1, items: ["korean-bun"], tags: ["taste", "late-delivery"] });
    assert.equal(low.status, 200);
    assert.match(low.body.text, /Korean Bun/);
    assert.doesNotMatch(low.body.text, /taste/i, "praise tags are not offered at 1 star");
    assert.match(low.body.text, /late delivery/i);
    const cfg = await (await fetch(`${base}/api/review/config`)).json();
    assert.equal(cfg.reviewPageUrl, "https://de25.example.in/review/");
    // The printable QR card is owner-only: nothing public, QR needs the admin login.
    assert.equal((await fetch(`${base}/review/card.html`)).status, 404);
    assert.equal((await fetch(`${base}/review/qr.svg`)).status, 404);
    const keepAdmin = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = "test-admin-token";
    try {
      assert.equal((await fetch(`${base}/api/admin/review-qr.svg`)).status, 401);
      assert.equal((await fetch(`${base}/api/admin/review-qr.png`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
      const svg = await fetch(`${base}/api/admin/review-qr.svg`, { headers: { Authorization: "Bearer test-admin-token" } });
      assert.equal(svg.status, 200);
      assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
      const info = await (await fetch(`${base}/api/admin/review-qr.json`, { headers: { Authorization: "Bearer test-admin-token" } })).json();
      assert.equal(info.reviewPageUrl, "https://de25.example.in/review/");
    } finally {
      if (keepAdmin === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = keepAdmin;
    }
    const page = await fetch(`${base}/review/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /How was your DE\.25 treat\?/);
    const short = await fetch(`${base}/review.html`, { redirect: "manual" });
    assert.equal(short.status, 302);
    const bad = await fetch(`${base}/api/review/suggest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    assert.deepEqual(await bad.json(), { error: "Invalid request body." });
  } finally {
    delete process.env.PUBLIC_SITE_URL;
    server.close();
  }
});


// --- Online payments: every way a payment can go wrong (server/payments/service.js) ---
const { RazorpayPaymentProvider, hmacHex } = require("../server/payments/RazorpayPaymentProvider");
const paymentsFactory = require("../server/payments");
const paySvc = require("../server/payments/service");
// These tests place more orders than one IP may in a minute — reset the limiters between them.
const resetLimits = () => {
  const limits = require("../server/middleware/rateLimit");
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) for (const l of [limits.writeLimiter, limits.apiLimiter, limits.paymentLimiter]) l.resetKey(key);
};

test("razorpay: checkout and webhook signatures are verified, tampering is rejected", () => {
  const rz = new RazorpayPaymentProvider({ keyId: "rzp_test_x", keySecret: "key-secret", webhookSecret: "hook-secret" });
  const sig = hmacHex("key-secret", "order_A|pay_B");
  assert.equal(rz.verifyCheckoutSignature({ gatewayOrderId: "order_A", paymentId: "pay_B", signature: sig }), true);
  assert.equal(rz.verifyCheckoutSignature({ gatewayOrderId: "order_A", paymentId: "pay_OTHER", signature: sig }), false);
  assert.equal(rz.verifyCheckoutSignature({ gatewayOrderId: "order_A", paymentId: "pay_B", signature: "" }), false);
  const body = JSON.stringify({ event: "payment.captured" });
  assert.equal(rz.verifyWebhook(body, hmacHex("hook-secret", body)), true);
  assert.equal(rz.verifyWebhook(body + " ", hmacHex("hook-secret", body)), false);
  assert.equal(new RazorpayPaymentProvider({ keyId: "a", keySecret: "b" }).verifyWebhook(body, hmacHex("", body)), false, "no webhook secret = reject all");
});

test("payments http: failed, paid-after-close, duplicate, wrong amount, expired, late, unmatched and refunded payments", async () => {
  const fs = require("fs");
  const path = require("path");
  const { app } = require("../server/index.js");
  await require("../server/products").initProducts();
  const notificationsPath = path.join(__dirname, "..", "data", "notifications.json");
  const { UNMATCHED_FILE } = require("../server/payments/unmatchedStore");
  const unmatchedBefore = fs.existsSync(UNMATCHED_FILE) ? fs.readFileSync(UNMATCHED_FILE, "utf8") : null;

  // A fake Razorpay: just enough of its API for orders, payments and reconcile.
  const rzState = { orders: {}, payments: {}, n: 0 };
  const fakeFetch = async (url, opts = {}) => {
    const u = new URL(url);
    const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    if (opts.method === "POST" && u.pathname === "/v1/orders") {
      const body = JSON.parse(opts.body);
      const id = `order_T${++rzState.n}`;
      rzState.orders[id] = { id, amount: body.amount, notes: body.notes };
      return reply({ id, amount: body.amount, currency: "INR" });
    }
    let m = u.pathname.match(/^\/v1\/orders\/([^/]+)\/payments$/);
    if (m) return reply({ items: Object.values(rzState.payments).filter((p) => p.order_id === m[1]) });
    m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/);
    if (m) return rzState.payments[m[1]] ? reply(rzState.payments[m[1]]) : reply({ error: { description: "not found" } }, 404);
    return reply({ error: { description: "unexpected" } }, 400);
  };
  const rz = new RazorpayPaymentProvider({ keyId: "rzp_test_key", keySecret: "key-secret", webhookSecret: "hook-secret", fetchImpl: fakeFetch });
  paymentsFactory._setPaymentProvider(rz);

  const pay = (id, orderId, amount, status = "captured", extra = {}) =>
    (rzState.payments[id] = { id, order_id: orderId, amount, status, method: "upi", vpa: "cust@okbank", created_at: Math.floor(Date.now() / 1000), ...extra });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const webhook = (event, entity, extra = {}) => {
    const raw = JSON.stringify({ event, payload: { payment: { entity }, ...extra } });
    return call("POST", "/api/payments/webhook", raw, { "X-Razorpay-Signature": hmacHex("hook-secret", raw) });
  };
  const keepAdmin = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "pay-test-admin";
  const admin = { Authorization: "Bearer pay-test-admin" };
  const slips = (orderId) => {
    try { return JSON.parse(fs.readFileSync(notificationsPath, "utf8")).filter((n) => n.orderId === orderId && n.type === "customer_order_slip").length; }
    catch { return 0; }
  };
  const product = getAllProducts().find((p) => !p.variants && p.availability !== false);
  let phoneN = 9700000000;
  const placeOrder = async () => {
    resetLimits();
    const phone = String(++phoneN);
    const token = pv.confirmCode(phone, pv.issueCode(phone).code).token;
    const r = await call("POST", "/api/checkout", {
      customer: { name: "Pay Test", phone },
      address: { house: "1", street: "Main Road", area: "Sector 5", city: "Navi Mumbai", pincode: "400701" },
      items: [{ productId: product.productId, qty: 1 }],
      paymentMethod: "upi",
      phoneVerificationToken: token,
    });
    assert.equal(r.status, 201);
    return r.body;
  };
  const getAdminOrder = async (id) => (await call("GET", `/api/admin/orders/${id}`, undefined, admin)).body.order;

  try {
    // 1. Checkout: order saved but NOT confirmed; the browser gets only public payment params.
    const o1 = await placeOrder();
    assert.equal(o1.status, "AWAITING_PAYMENT");
    assert.equal(o1.checkout.provider, "razorpay");
    assert.equal(o1.checkout.keyId, "rzp_test_key");
    assert.equal(JSON.stringify(o1).includes("key-secret"), false, "the key secret never reaches the browser");
    const gw1 = o1.checkout.gatewayOrderId;
    const amount = o1.checkout.amountPaise;
    assert.equal(amount, Math.round(o1.total * 100));

    // 2. Failed attempt: recorded with the bank's reason; still unpaid; kitchen can't start it; no receipt.
    pay("pay_fail1", gw1, amount, "failed", { error_code: "BAD_REQUEST_ERROR", error_description: "Payment declined by bank" });
    assert.equal((await webhook("payment.failed", rzState.payments.pay_fail1)).status, 200);
    let a1 = await getAdminOrder(o1.orderId);
    assert.equal(a1.status, "AWAITING_PAYMENT");
    assert.equal(a1.payment.status, "FAILED");
    assert.equal(a1.payment.attempts[0].errorReason, "Payment declined by bank");
    assert.equal((await call("PUT", `/api/admin/orders/${o1.orderId}/advance`, undefined, admin)).status, 409, "can't prepare an unpaid order");
    const cust = (await call("GET", `/api/orders/${o1.orderId}`)).body;
    assert.equal(cust.payment.canPay, true);
    assert.equal(cust.payment.lastFailureReason, "Payment declined by bank");
    assert.equal(slips(o1.orderId), 0);

    // 3. A forged "success" from the browser is rejected.
    pay("pay_ok1", gw1, amount);
    const forged = await call("POST", `/api/payments/${o1.orderId}/verify`, { razorpay_order_id: gw1, razorpay_payment_id: "pay_ok1", razorpay_signature: "f".repeat(64) });
    assert.equal(forged.status, 400);
    assert.equal((await getAdminOrder(o1.orderId)).payment.status, "FAILED");

    // 4. Genuine success: signature checked + payment fetched from the gateway -> PAID, confirmed, receipt sent once.
    const ok = await call("POST", `/api/payments/${o1.orderId}/verify`, { razorpay_order_id: gw1, razorpay_payment_id: "pay_ok1", razorpay_signature: hmacHex("key-secret", `${gw1}|pay_ok1`) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.order.status, "PAYMENT_CONFIRMED");
    assert.equal(ok.body.order.payment.paymentId, "pay_ok1");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(slips(o1.orderId), 1);

    // 5. The same payment arriving again by webhook changes nothing (no 2nd receipt, no false duplicate).
    await webhook("payment.captured", rzState.payments.pay_ok1);
    await new Promise((r) => setTimeout(r, 150));
    a1 = await getAdminOrder(o1.orderId);
    assert.equal(slips(o1.orderId), 1);
    assert.equal(a1.payment.issues.length, 0);
    assert.equal(a1.payment.vpa, "cust@okbank");

    // 6. Charged twice -> flagged for refund; the refund webhook then clears it.
    pay("pay_dup1", gw1, amount);
    await webhook("payment.captured", rzState.payments.pay_dup1);
    a1 = await getAdminOrder(o1.orderId);
    assert.deepEqual(a1.payment.issues.map((i) => [i.code, i.paymentId]), [["DUPLICATE_PAYMENT", "pay_dup1"]]);
    await webhook("refund.processed", rzState.payments.pay_dup1, { refund: { entity: { id: "rfnd_1", payment_id: "pay_dup1", amount, created_at: 1 } } });
    a1 = await getAdminOrder(o1.orderId);
    assert.equal(a1.payment.issues[0].resolved, true);
    assert.equal(a1.payment.status, "PAID", "refunding the extra charge leaves the order paid");

    // 7. Paid, but the customer closed the page before we heard back (and no webhook): "Check payment" finds it.
    const o2 = await placeOrder();
    pay("pay_closed", o2.checkout.gatewayOrderId, amount);
    const rec = await call("POST", `/api/admin/orders/${o2.orderId}/reconcile`, undefined, admin);
    assert.equal(rec.status, 200);
    assert.equal(rec.body.order.status, "PAYMENT_CONFIRMED");
    assert.equal(rec.body.order.payment.attempts[0].source, "owner-check");

    // 8. Wrong amount -> NOT confirmed, flagged.
    const o3 = await placeOrder();
    pay("pay_short", o3.checkout.gatewayOrderId, amount - 100);
    await webhook("payment.captured", rzState.payments.pay_short);
    const a3 = await getAdminOrder(o3.orderId);
    assert.equal(a3.status, "AWAITING_PAYMENT");
    assert.equal(a3.payment.issues[0].code, "AMOUNT_MISMATCH");

    // 9. Never paid -> cancelled after the payment window; paying later reopens it and flags it.
    const o4 = await placeOrder();
    const [expired] = await paySvc.sweep([await getAdminOrder(o4.orderId)], { now: Date.now() + 31 * 60 * 1000 });
    assert.equal(expired.status, "CANCELLED");
    assert.equal(expired.payment.status, "EXPIRED");
    assert.equal((await call("POST", `/api/payments/${o4.orderId}/start`, {})).status, 409, "can't pay an expired order from the site");
    pay("pay_late", o4.checkout.gatewayOrderId, amount);
    await webhook("payment.captured", rzState.payments.pay_late);
    const a4 = await getAdminOrder(o4.orderId);
    assert.equal(a4.status, "PAYMENT_CONFIRMED");
    assert.equal(a4.payment.issues[0].code, "PAID_AFTER_EXPIRY");
    const resolved = await call("POST", `/api/admin/orders/${o4.orderId}/issues/resolve`, { code: "PAID_AFTER_EXPIRY", paymentId: "pay_late" }, admin);
    assert.equal(resolved.body.order.payment.issues[0].resolved, true);

    // 10. Authorised but not captured -> flagged, not confirmed.
    const o5 = await placeOrder();
    pay("pay_auth", o5.checkout.gatewayOrderId, amount, "authorized");
    await webhook("payment.authorized", rzState.payments.pay_auth);
    const a5 = await getAdminOrder(o5.orderId);
    assert.equal(a5.status, "AWAITING_PAYMENT");
    assert.equal(a5.payment.status, "AUTHORIZED");
    assert.equal(a5.payment.issues[0].code, "AUTHORIZED_NOT_CAPTURED");

    // 11. Payment for an order we don't know -> listed for the owner.
    pay("pay_orphan", "order_UNKNOWN", 49900);
    await webhook("payment.captured", rzState.payments.pay_orphan);
    const issues = (await call("GET", "/api/admin/payment-issues", undefined, admin)).body.unmatched;
    assert.ok(issues.some((u) => u.paymentId === "pay_orphan" && u.amountPaise === 49900));
    assert.equal((await call("POST", "/api/admin/payment-issues/pay_orphan/resolve", undefined, admin)).status, 200);

    // 12. Full refund of the real payment -> REFUNDED.
    await webhook("refund.processed", rzState.payments.pay_closed, { refund: { entity: { id: "rfnd_2", payment_id: "pay_closed", amount, created_at: 1 } } });
    assert.equal((await getAdminOrder(o2.orderId)).payment.status, "REFUNDED");

    // 13. Webhooks without a valid signature are ignored.
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: rzState.payments.pay_short } } });
    assert.equal((await call("POST", "/api/payments/webhook", raw, { "X-Razorpay-Signature": "bad" })).status, 400);

    // Admin list exposes the payment mode.
    const list = (await call("GET", "/api/admin/orders?limit=5", undefined, admin)).body;
    assert.deepEqual(list.payments, { provider: "razorpay", isLive: true });
  } finally {
    paymentsFactory._resetPaymentProvider();
    if (keepAdmin === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = keepAdmin;
    if (unmatchedBefore === null) fs.rmSync(UNMATCHED_FILE, { force: true }); else fs.writeFileSync(UNMATCHED_FILE, unmatchedBefore);
    server.close();
  }
});

test("payments demo: failure then success on the same order; demo endpoint is off when a real gateway is active", async () => {
  const { app } = require("../server/index.js");
  await require("../server/products").initProducts();
  paymentsFactory._resetPaymentProvider();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    resetLimits();
    const phone = "9600000001";
    const token = pv.confirmCode(phone, pv.issueCode(phone).code).token;
    const product = getAllProducts().find((p) => !p.variants && p.availability !== false);
    const placed = (await call("POST", "/api/checkout", {
      customer: { name: "Demo Pay", phone },
      address: { house: "1", street: "Main Road", area: "Sector 5", city: "Navi Mumbai", pincode: "400701" },
      items: [{ productId: product.productId, qty: 1 }],
      paymentMethod: "upi",
      phoneVerificationToken: token,
    })).body;
    assert.equal(placed.checkout.provider, "demo");
    const failed = await call("POST", `/api/payments/${placed.orderId}/demo`, { outcome: "failure" });
    assert.equal(failed.body.order.payment.status, "FAILED");
    assert.equal(failed.body.order.status, "AWAITING_PAYMENT");
    const retry = await call("POST", `/api/payments/${placed.orderId}/start`, {});
    assert.equal(retry.status, 200);
    assert.equal(retry.body.checkout.gatewayOrderId, placed.checkout.gatewayOrderId);
    const paid = await call("POST", `/api/payments/${placed.orderId}/demo`, { outcome: "success" });
    assert.equal(paid.body.order.status, "PAYMENT_CONFIRMED");
    const again = await call("POST", `/api/payments/${placed.orderId}/demo`, { outcome: "success" });
    assert.equal(again.body.order.payment.paymentId, paid.body.order.payment.paymentId, "double tap doesn't charge twice");

    paymentsFactory._setPaymentProvider(new RazorpayPaymentProvider({ keyId: "k", keySecret: "s" }));
    assert.equal((await call("POST", `/api/payments/${placed.orderId}/demo`, { outcome: "success" })).status, 404, "no demo payments with a real gateway");
  } finally {
    paymentsFactory._resetPaymentProvider();
    server.close();
  }
});

// --- Owner dashboard revenue (server/lib/revenue.js) ---
test("revenue: counts only confirmed payments, net of refunds, by India day/month/year; demo excluded once live", () => {
  const { computeRevenue } = require("../server/lib/revenue");
  const now = new Date("2026-10-01T10:00:00+05:30");
  const paid = (paidAt, rupees, extra = {}) => ({
    orderId: Math.random().toString(36),
    status: "PAYMENT_CONFIRMED",
    total: rupees,
    createdAt: paidAt,
    lines: [{ name: "Tiramisu", qty: 1, lineTotal: rupees }],
    payment: { provider: "razorpay", status: "PAID", paymentId: "pay_x", amountPaise: rupees * 100, amountPaidPaise: rupees * 100, paidAt, refunds: [], ...extra },
  });
  const orders = [
    paid("2026-10-01T00:10:00+05:30", 300), // today in India (still Sept 30 in UTC)
    paid("2026-09-30T23:50:00+05:30", 200), // yesterday
    paid("2026-09-15T12:00:00+05:30", 500, { status: "PARTIALLY_REFUNDED", refunds: [{ paymentId: "pay_x", amountPaise: 10000, status: "processed" }, { paymentId: "pay_dup", amountPaise: 50000, status: "processed" }] }),
    paid("2025-12-31T20:00:00+05:30", 1000), // last year
    paid("2026-10-01T09:00:00+05:30", 999, { status: "FAILED" }), // never paid
    paid("2026-10-01T09:00:00+05:30", 999, { status: "EXPIRED" }),
    paid("2026-10-01T09:00:00+05:30", 777, { provider: "demo" }), // demo test order
  ];
  const r = computeRevenue(orders, { now, liveProvider: "razorpay" });
  assert.equal(r.today, "2026-10-01");
  assert.deepEqual([r.summary.today.revenuePaise, r.summary.today.orders], [30000, 1]);
  assert.equal(r.summary.yesterday.revenuePaise, 20000);
  assert.equal(r.summary.thisMonth.revenuePaise, 30000);
  assert.equal(r.summary.lastMonth.revenuePaise, 20000 + 40000, "refund of the order's own payment is subtracted; a duplicate charge's refund is not");
  assert.equal(r.summary.lastMonth.refundsPaise, 10000);
  assert.equal(r.summary.thisYear.revenuePaise, 30000 + 20000 + 40000);
  assert.equal(r.summary.lastYear.revenuePaise, 100000);
  assert.equal(r.daily.length, 30);
  assert.equal(r.daily[29].key, "2026-10-01");
  assert.equal(r.monthly.length, 12);
  assert.deepEqual([r.monthly[0].key, r.monthly[11].key], ["2025-11", "2026-10"]);
  assert.deepEqual(r.yearly.map((y) => y.key), ["2025", "2026"]);
  assert.equal(r.topItems.thisYear[0].name, "Tiramisu");
  // While still on demo payments, demo orders do count (so the owner can see the dashboard working).
  assert.equal(computeRevenue(orders, { now }).summary.today.revenuePaise, 30000 + 77700);
});
