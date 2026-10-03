const { DemoDeliveryProvider } = require("./DemoDeliveryProvider");
const { BorzoDeliveryProvider } = require("./BorzoDeliveryProvider");
const { resolveBorzoConfig } = require("./borzoConfig");

let cachedProvider = null;

/**
 * The single place that decides which DeliveryProvider is active.
 *
 * Borzo is used only when every switch in ./borzoConfig.js is set:
 * BORZO_DELIVERY_ENABLED=true, a token, the pickup address and phone, and —
 * for production only — BORZO_LIVE_CONFIRM. BORZO_ENV defaults to "test"
 * (Borzo's sandbox: real API, real order ids and tracking pages, no real
 * courier, no charge). Anything missing falls back to the demo provider
 * with a loud warning rather than crashing the storefront, and the owner
 * dashboard's Borzo panel lists exactly what is missing.
 *
 * No route or frontend code changes between demo, sandbox and production —
 * everything downstream talks to the DeliveryProvider interface.
 */
function getDeliveryProvider() {
  if (cachedProvider) return cachedProvider;

  const cfg = resolveBorzoConfig();

  if (cfg.active) {
    cachedProvider = new BorzoDeliveryProvider({
      token: cfg.token,
      environment: cfg.environment,
      version: cfg.version,
      vehicleTypeId: cfg.vehicleTypeId,
      pickup: cfg.pickup,
    });
    return cachedProvider;
  }

  if (cfg.enabled) {
    // Fail safe, not silent: someone flipped the flag without finishing
    // setup. Logged loudly so it isn't mistaken for "Borzo is live".
    // eslint-disable-next-line no-console
    console.warn(`[delivery] BORZO_DELIVERY_ENABLED=true but ${cfg.problems.join("; ")} — falling back to DemoDeliveryProvider.`);
  }

  cachedProvider = new DemoDeliveryProvider();
  return cachedProvider;
}

/** Test/reload hook — not used in normal request handling. */
function _resetProviderCache() {
  cachedProvider = null;
}

module.exports = { getDeliveryProvider, _resetProviderCache };
