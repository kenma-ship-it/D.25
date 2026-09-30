/**
 * Google-Sheets-backed product catalog — lets DE.25's owner edit the menu
 * in a spreadsheet instead of a JSON file, no code deploy required.
 *
 * Inert until fully configured (same "never claim a live connection that
 * isn't real" rule as server/delivery/BorzoDeliveryProvider.js and
 * server/notifications/WhatsAppCloudProvider.js): the factory in ./index.js
 * only ever instantiates this class once GOOGLE_SHEETS_PRODUCTS_ENABLED is
 * true AND a spreadsheet ID + service-account credentials are all present.
 *
 * --- One-time setup (put this in the README, this is the short version) ---
 *   1. Create a Google Cloud service account, enable the Sheets API for its
 *      project, and generate a JSON key for it.
 *   2. Share the target Google Sheet with that service account's email
 *      (Editor access if the admin dashboard should be able to write
 *      price/availability edits back; Viewer if the sheet should be
 *      read-only from this app's side).
 *   3. Put the service account's `client_email` and `private_key` (with its
 *      literal newlines) into GOOGLE_SERVICE_ACCOUNT_EMAIL /
 *      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, and the sheet's ID (the long
 *      value in its URL between /d/ and /edit) into GOOGLE_SHEETS_ID.
 *   4. Give the sheet two tabs named "Products" and "Categories" with a
 *      header row — see data/products-sheet-template.csv for exact column
 *      names and a pre-filled example (import it as the Products tab).
 *
 * --- Design notes ---
 * Reads are header-driven (row 1 names the columns, order doesn't matter)
 * so a non-technical owner reorganizing columns in their own spreadsheet
 * doesn't silently corrupt the catalog. Multi-value fields (ingredients,
 * gallery, allergens, dietaryTags) are comma-separated within one cell.
 * A refresh() re-fetches everything and swaps the in-memory cache in one
 * go — a half-updated sheet (owner mid-edit) never produces a half-updated
 * cache, because the swap only happens after the whole fetch succeeds.
 * If a refresh fails (network blip, sheet temporarily unshared, etc.) the
 * previous good cache is kept and served — a transient Sheets outage
 * should degrade to "stale menu" for a few minutes, never "menu vanishes".
 */
const { ProductsProvider } = require("./ProductsProvider");
const { getAccessToken } = require("../lib/googleServiceAccountAuth");

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

const TRUE_STRINGS = new Set(["true", "yes", "1", "y"]);

function toBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return TRUE_STRINGS.has(String(value).trim().toLowerCase());
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toList(value) {
  if (value === undefined || value === null || String(value).trim() === "") return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toListOrNull(value) {
  const list = toList(value);
  return list.length ? list : null;
}

/** Turns a header row + one data row into { headerNameLowerCase: cellValue }. */
function rowToRecord(headers, row) {
  const record = {};
  headers.forEach((h, i) => {
    record[String(h || "").trim().toLowerCase()] = row[i] !== undefined ? row[i] : "";
  });
  return record;
}

function recordToProduct(r) {
  return {
    productId: String(r.productid || "").trim(),
    name: String(r.name || "").trim(),
    category: String(r.category || "").trim(),
    description: String(r.description || "").trim(),
    price: toNumberOrNull(r.price) || 0,
    menuConfirmed: toBool(r.menuconfirmed, true),
    priceNote: r.pricenote && String(r.pricenote).trim() ? String(r.pricenote).trim() : null,
    image: r.image && String(r.image).trim() ? String(r.image).trim() : null,
    photoConfirmed: toBool(r.photoconfirmed, false),
    photoNote: r.photonote && String(r.photonote).trim() ? String(r.photonote).trim() : null,
    gallery: toList(r.gallery).length ? toList(r.gallery) : r.image ? [String(r.image).trim()] : [],
    ingredients: toList(r.ingredients),
    ingredientsConfirmed: toBool(r.ingredientsconfirmed, false),
    allergens: toListOrNull(r.allergens),
    servingSize: r.servingsize && String(r.servingsize).trim() ? String(r.servingsize).trim() : null,
    nutrition: {
      calories: toNumberOrNull(r.calories),
      protein: toNumberOrNull(r.protein),
      carbohydrates: toNumberOrNull(r.carbohydrates),
      fat: toNumberOrNull(r.fat),
      sugar: toNumberOrNull(r.sugar),
    },
    dietaryTags: toList(r.dietarytags),
    availability: toBool(r.availability, true),
    featured: toBool(r.featured, false),
    deliveryAvailable: toBool(r.deliveryavailable, true),
  };
}

function recordToCategory(r) {
  return {
    id: String(r.id || "").trim(),
    label: String(r.label || "").trim(),
    description: String(r.description || "").trim(),
  };
}

class GoogleSheetsProductsProvider extends ProductsProvider {
  constructor({
    spreadsheetId,
    productsRange = "Products!A1:Z1000",
    categoriesRange = "Categories!A1:C1000",
  }) {
    super();
    this.spreadsheetId = spreadsheetId;
    this.productsRange = productsRange;
    this.categoriesRange = categoriesRange;
    this._cache = null; // { products, categories }
    this._lastGoodAt = null;
    this._refreshTimer = null;
  }

  get name() {
    return "google-sheets";
  }

  async _fetchRange(range) {
    const accessToken = await getAccessToken();
    const url = `${SHEETS_API_BASE}/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Sheets API GET ${range} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return Array.isArray(data.values) ? data.values : [];
  }

  async refresh() {
    const [productRows, categoryRows] = await Promise.all([
      this._fetchRange(this.productsRange),
      this._fetchRange(this.categoriesRange),
    ]);

    if (productRows.length === 0) {
      throw new Error("Products sheet returned no rows (check the range/tab name and sharing).");
    }

    const [productHeaders, ...productDataRows] = productRows;
    const products = productDataRows
      .filter((row) => row.some((cell) => String(cell || "").trim() !== ""))
      .map((row) => recordToProduct(rowToRecord(productHeaders, row)))
      .filter((p) => p.productId);

    let categories = [];
    if (categoryRows.length > 0) {
      const [categoryHeaders, ...categoryDataRows] = categoryRows;
      categories = categoryDataRows
        .filter((row) => row.some((cell) => String(cell || "").trim() !== ""))
        .map((row) => recordToCategory(rowToRecord(categoryHeaders, row)))
        .filter((c) => c.id);
    }

    // Swap only after both fetches AND parsing fully succeed — see the
    // file header's note on why a partial/failed refresh keeps the old cache.
    this._cache = { products, categories };
    this._lastGoodAt = new Date().toISOString();
    return this._cache;
  }

  /** Starts a periodic background refresh; safe to call once at boot. */
  startAutoRefresh(intervalMs) {
    if (this._refreshTimer) return;
    this._refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          `[products] Google Sheets refresh failed, continuing to serve the last good catalog` +
            (this._lastGoodAt ? ` (from ${this._lastGoodAt})` : " (none loaded yet)") +
            `:`,
          err.message
        );
      });
    }, intervalMs);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  _requireCache() {
    if (!this._cache) {
      throw new Error(
        "Google Sheets product catalog has not loaded yet — refresh() must succeed at least once before reads."
      );
    }
    return this._cache;
  }

  getAllProducts({ includeUnavailable = false } = {}) {
    const { products } = this._requireCache();
    return includeUnavailable ? products.slice() : products.filter((p) => p.availability);
  }

  getProductById(productId) {
    const { products } = this._requireCache();
    return products.find((p) => p.productId === productId) || null;
  }

  getProductsByCategory(category) {
    const { products } = this._requireCache();
    return products.filter((p) => p.availability && p.category === category);
  }

  getCategories() {
    const { categories } = this._requireCache();
    return categories.slice();
  }

  /**
   * Updates the in-memory cache immediately (so the admin dashboard sees
   * its own edit right away) and fires a best-effort write-back to the
   * Sheet in the background. If the write-back fails, the edit still holds
   * in memory until the next successful refresh() overwrites it from the
   * sheet — logged loudly rather than silently lost, but never blocking or
   * failing the admin request itself (same fire-and-forget principle used
   * for delivery orders and notifications).
   */
  setProduct(productId, updates) {
    const { products } = this._requireCache();
    const idx = products.findIndex((p) => p.productId === productId);
    if (idx === -1) return null;
    products[idx] = { ...products[idx], ...updates, productId };
    this._writeBackRow(products[idx]).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[products] failed to write product "${productId}" back to Google Sheets (edit is still applied in memory, but will be overwritten by the next successful sheet refresh):`,
        err.message
      );
    });
    return products[idx];
  }

  async _writeBackRow(product) {
    const rows = await this._fetchRange(this.productsRange);
    if (rows.length === 0) throw new Error("Products sheet is empty — nothing to write back to.");
    const [headers, ...dataRows] = rows;
    const idColIndex = headers.findIndex((h) => String(h || "").trim().toLowerCase() === "productid");
    if (idColIndex === -1) throw new Error('Products sheet has no "productId" column.');

    const rowOffset = dataRows.findIndex((row) => String(row[idColIndex] || "").trim() === product.productId);
    if (rowOffset === -1) throw new Error(`No row found for productId "${product.productId}".`);
    const sheetRowNumber = rowOffset + 2; // +1 for header row, +1 for 1-indexing

    const fieldByHeader = {
      name: product.name,
      description: product.description,
      price: product.price,
      availability: product.availability ? "TRUE" : "FALSE",
      featured: product.featured ? "TRUE" : "FALSE",
      ingredients: (product.ingredients || []).join(", "),
      allergens: (product.allergens || []).join(", "),
      dietarytags: (product.dietaryTags || []).join(", "),
    };

    const rowValues = headers.map((h) => {
      const key = String(h || "").trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(fieldByHeader, key) ? fieldByHeader[key] : undefined;
    });

    // Only touch columns this app actually manages via the admin API
    // (matches the same fixed allowlist server/routes/admin.js already
    // enforces) — every other cell in the row is left exactly as the
    // owner wrote it in the spreadsheet.
    const updates = headers
      .map((h, i) => ({ header: String(h || "").trim().toLowerCase(), i }))
      .filter(({ header }) => Object.prototype.hasOwnProperty.call(fieldByHeader, header))
      .map(({ i }) => ({ i, value: rowValues[i] }));

    const accessToken = await getAccessToken();
    const sheetName = this.productsRange.split("!")[0];
    const data = updates.map(({ i, value }) => ({
      range: `${sheetName}!${columnLetter(i)}${sheetRowNumber}`,
      values: [[value]],
    }));

    const res = await fetch(
      `${SHEETS_API_BASE}/${encodeURIComponent(this.spreadsheetId)}/values:batchUpdate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ valueInputOption: "RAW", data }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Sheets API batchUpdate failed (${res.status}): ${body.slice(0, 300)}`);
    }
  }
}

/** 0 -> A, 1 -> B, ... 26 -> AA, matching Sheets' A1 column notation. */
function columnLetter(index) {
  let n = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

module.exports = { GoogleSheetsProductsProvider, rowToRecord, recordToProduct, recordToCategory };
