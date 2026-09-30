/**
 * Product catalog provider factory — same job as server/delivery/index.js
 * and server/notifications/index.js, applied to the product catalog.
 *
 * Chooses the backend ONCE per process (like the other two factories) and
 * caches it. Unlike delivery/notifications, a failed product-catalog load
 * would break the entire site (no menu = nothing to sell), not just one
 * feature — so this factory is deliberately conservative: if Google Sheets
 * is enabled but misconfigured, unreachable, or its very first refresh
 * fails, it falls back to the always-available JSON file catalog for the
 * rest of the process rather than leaving the site with an empty menu.
 * Fix the sheet/config and restart the server to retry — same "restart to
 * pick up new env vars" contract as BORZO_DELIVERY_ENABLED and
 * WHATSAPP_NOTIFICATIONS_ENABLED already use.
 */
const { JsonFileProductsProvider } = require("./JsonFileProductsProvider");
const { GoogleSheetsProductsProvider } = require("./GoogleSheetsProductsProvider");

const DEFAULT_REFRESH_MS = 5 * 60 * 1000; // 5 minutes — the menu doesn't need to be faster than this

let cachedProvider = null;
let readyPromise = null;

function buildProvider() {
  const sheetsEnabled = String(process.env.GOOGLE_SHEETS_PRODUCTS_ENABLED || "false").toLowerCase() === "true";
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const hasCredentials = Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && spreadsheetId
  );

  if (sheetsEnabled && !hasCredentials) {
    // eslint-disable-next-line no-console
    console.warn(
      "[products] GOOGLE_SHEETS_PRODUCTS_ENABLED=true but GOOGLE_SHEETS_ID / " +
        "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not all set — " +
        "falling back to the JSON file catalog."
    );
    return { provider: new JsonFileProductsProvider(), isSheets: false };
  }

  if (sheetsEnabled && hasCredentials) {
    return {
      provider: new GoogleSheetsProductsProvider({
        spreadsheetId,
        productsRange: process.env.GOOGLE_SHEETS_PRODUCTS_RANGE || "Products!A1:Z1000",
        categoriesRange: process.env.GOOGLE_SHEETS_CATEGORIES_RANGE || "Categories!A1:C1000",
      }),
      isSheets: true,
    };
  }

  return { provider: new JsonFileProductsProvider(), isSheets: false };
}

/**
 * Must be called once at server boot, before the app starts accepting
 * requests — see server/index.js. Resolves once a working catalog (Sheets
 * or the JSON fallback) is loaded; never rejects, so a misconfigured sheet
 * can't stop the server from starting.
 */
async function initProducts() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const { provider, isSheets } = buildProvider();
    cachedProvider = provider;

    if (!isSheets) {
      // eslint-disable-next-line no-console
      console.log("[products] JSON file catalog active (data/products.json).");
      return;
    }

    try {
      await provider.refresh();
      provider.startAutoRefresh(Number(process.env.GOOGLE_SHEETS_REFRESH_MS) || DEFAULT_REFRESH_MS);
      // eslint-disable-next-line no-console
      console.log(`[products] Google Sheets catalog active (${provider.getAllProducts({ includeUnavailable: true }).length} products loaded).`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[products] Initial Google Sheets load failed — falling back to the JSON file catalog for this run. " +
          "Fix the sheet ID/sharing/credentials and restart the server to retry. Error:",
        err.message
      );
      cachedProvider = new JsonFileProductsProvider();
    }
  })();

  return readyPromise;
}

function getProvider() {
  if (!cachedProvider) {
    // Safety net for anything that runs before initProducts() (e.g. unit
    // tests importing this module directly) — falls back to the JSON
    // provider rather than throwing, matching the JSON provider's own
    // synchronous-first-load behaviour.
    cachedProvider = new JsonFileProductsProvider();
  }
  return cachedProvider;
}

function getAllProducts(opts) {
  return getProvider().getAllProducts(opts);
}
function getProductById(productId) {
  return getProvider().getProductById(productId);
}
function getProductsByCategory(category) {
  return getProvider().getProductsByCategory(category);
}
function getCategories() {
  return getProvider().getCategories();
}
function setProduct(productId, updates) {
  return getProvider().setProduct(productId, updates);
}

/**
 * Force a reload. For the JSON provider this is synchronous and immediate.
 * For the Google Sheets provider this kicks off a background refresh and
 * returns immediately — the catalog updates a moment later once the fetch
 * completes, it is NOT synchronous like the JSON path. Callers that need
 * to know when a Sheets refresh actually finishes should await
 * refreshProducts() instead.
 */
function reload() {
  const provider = getProvider();
  if (provider.name === "json-file") {
    return provider.refresh();
  }
  provider.refresh().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[products] manual reload() failed:", err.message);
  });
  return null;
}

/** Awaitable refresh — resolves once the active provider's cache is updated (or rejects on failure). */
function refreshProducts() {
  return getProvider().refresh();
}

function getActiveProviderName() {
  return getProvider().name;
}

/** Test-only: forget the cached provider/init state so the next call rebuilds from current env vars. */
function _resetProviderCache() {
  cachedProvider = null;
  readyPromise = null;
}

module.exports = {
  initProducts,
  getAllProducts,
  getProductById,
  getProductsByCategory,
  getCategories,
  setProduct,
  reload,
  refreshProducts,
  getActiveProviderName,
  _resetProviderCache,
};
