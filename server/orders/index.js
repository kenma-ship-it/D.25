/**
 * Order store factory — same job as server/products/index.js, applied to
 * order persistence. Chosen once per process based on env config; a
 * restart is required to pick up a changed SUPABASE_ORDERS_ENABLED, same
 * "restart to retry" contract as the products/delivery/notifications
 * factories.
 *
 * Unlike products, a missing/misconfigured Supabase setup here does NOT
 * fall back silently to the JSON store after boot — orders are the one
 * thing in this app where "silently switched storage backend without
 * telling anyone" would be a real business problem (an owner expecting
 * orders in Supabase, quietly getting a local JSON file instead, might
 * lose orders on their next deploy that wipes the filesystem). Instead:
 * if SUPABASE_ORDERS_ENABLED=true but credentials are missing, this logs a
 * loud warning and falls back to the JSON store for THIS boot only, same
 * as the other factories — the difference is purely that this comment
 * spells out why that matters more here.
 */
const { JsonFileOrdersStore, STATUSES, PRE_PAYMENT_STATUSES } = require("./JsonFileOrdersStore");
const { SupabaseOrdersStore } = require("./SupabaseOrdersStore");

let cachedStore = null;

function buildStore() {
  const supabaseEnabled = String(process.env.SUPABASE_ORDERS_ENABLED || "false").toLowerCase() === "true";
  const hasCredentials = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (supabaseEnabled && !hasCredentials) {
    // eslint-disable-next-line no-console
    console.warn(
      "[orders] SUPABASE_ORDERS_ENABLED=true but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both set — " +
        "falling back to the JSON file order store."
    );
    return new JsonFileOrdersStore();
  }

  if (supabaseEnabled && hasCredentials) {
    // eslint-disable-next-line no-console
    console.log("[orders] Supabase order store active.");
    return new SupabaseOrdersStore();
  }

  return new JsonFileOrdersStore();
}

function getStore() {
  if (!cachedStore) cachedStore = buildStore();
  return cachedStore;
}

function createOrder(args) {
  return getStore().createOrder(args);
}
function getOrder(orderId) {
  return getStore().getOrder(orderId);
}
function getAllOrders(opts) {
  return getStore().getAllOrders(opts);
}
function getOrdersByPhone(phone) {
  return getStore().getOrdersByPhone(phone);
}
function setStatus(orderId, status) {
  return getStore().setStatus(orderId, status);
}
function advanceStatus(orderId) {
  return getStore().advanceStatus(orderId);
}
function setDeliveryOrderId(orderId, deliveryOrderId) {
  return getStore().setDeliveryOrderId(orderId, deliveryOrderId);
}
function getOrderByGatewayOrderId(gatewayOrderId) {
  return getStore().getOrderByGatewayOrderId(gatewayOrderId);
}
function updateOrder(orderId, fields) {
  return getStore().updateOrder(orderId, fields);
}
function startDemoProgression(orderId) {
  return getStore().startDemoProgression(orderId);
}
function getActiveStoreName() {
  return getStore().name;
}

/** Test-only: forget the cached store so the next call rebuilds from current env vars. */
function _resetProviderCache() {
  cachedStore = null;
}

module.exports = {
  createOrder,
  getOrder,
  getAllOrders,
  getOrdersByPhone,
  setStatus,
  advanceStatus,
  setDeliveryOrderId,
  getOrderByGatewayOrderId,
  updateOrder,
  startDemoProgression,
  getActiveStoreName,
  STATUSES,
  PRE_PAYMENT_STATUSES,
  _resetProviderCache,
};
