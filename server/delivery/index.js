const { DemoDeliveryProvider } = require("./DemoDeliveryProvider");
const { BorzoDeliveryProvider } = require("./BorzoDeliveryProvider");

let cachedProvider = null;

/**
 * The single place that decides which DeliveryProvider is active.
 *
 * BORZO_DELIVERY_ENABLED defaults to false/unset, which is the correct
 * state until DE.25 approves going live AND real Borzo credentials exist.
 * Flipping that env var (plus setting BORZO_API_KEY) is the entire
 * migration from demo to live delivery — no route or frontend code needs
 * to change, because everything downstream talks to the DeliveryProvider
 * interface, not to a specific provider class.
 */
function getDeliveryProvider() {
  if (cachedProvider) return cachedProvider;

  const borzoEnabled = String(process.env.BORZO_DELIVERY_ENABLED || "false").toLowerCase() === "true";

  if (borzoEnabled && process.env.BORZO_API_KEY) {
    cachedProvider = new BorzoDeliveryProvider({
      apiKey: process.env.BORZO_API_KEY,
      apiUrl: process.env.BORZO_API_URL,
      pickupAddress: process.env.PICKUP_ADDRESS,
      pickupPhone: process.env.PICKUP_PHONE,
    });
    return cachedProvider;
  }

  if (borzoEnabled && !process.env.BORZO_API_KEY) {
    // Fail safe, not silent: someone flipped the flag without setting a key.
    // Falling back to the demo provider (rather than crashing the server)
    // keeps the storefront usable, but this is logged loudly so it gets
    // noticed and fixed rather than mistaken for "Borzo is live".
    // eslint-disable-next-line no-console
    console.warn(
      "[delivery] BORZO_DELIVERY_ENABLED=true but BORZO_API_KEY is not set — falling back to DemoDeliveryProvider."
    );
  }

  cachedProvider = new DemoDeliveryProvider();
  return cachedProvider;
}

/** Test/reload hook — not used in normal request handling. */
function _resetProviderCache() {
  cachedProvider = null;
}

module.exports = { getDeliveryProvider, _resetProviderCache };
