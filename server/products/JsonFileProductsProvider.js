/**
 * The default, zero-setup product catalog backend: data/products.json,
 * read into memory and written back on admin edits. This is the exact
 * behaviour server/lib/datastore.js had before the products backend became
 * pluggable — moved here unchanged so it can sit side-by-side with
 * GoogleSheetsProductsProvider.js behind the same interface.
 */
const fs = require("fs");
const path = require("path");
const { ProductsProvider } = require("./ProductsProvider");

const DATA_PATH = path.join(__dirname, "..", "..", "data", "products.json");

class JsonFileProductsProvider extends ProductsProvider {
  constructor() {
    super();
    this._cache = null;
  }

  get name() {
    return "json-file";
  }

  async refresh() {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.products)) {
      throw new Error("products.json is malformed: missing products array");
    }
    this._cache = parsed;
    return this._cache;
  }

  _load() {
    if (!this._cache) {
      // Synchronous first-load, same as the original datastore.js — the
      // JSON file is always available locally, so there's no reason to
      // force every call site to await a boot-time refresh() first.
      const raw = fs.readFileSync(DATA_PATH, "utf8");
      this._cache = JSON.parse(raw);
    }
    return this._cache;
  }

  getAllProducts({ includeUnavailable = false } = {}) {
    const { products } = this._load();
    return includeUnavailable ? products.slice() : products.filter((p) => p.availability);
  }

  getProductById(productId) {
    const { products } = this._load();
    return products.find((p) => p.productId === productId) || null;
  }

  getProductsByCategory(category) {
    const { products } = this._load();
    return products.filter((p) => p.availability && p.category === category);
  }

  getCategories() {
    const { categories } = this._load();
    return categories.slice();
  }

  setProduct(productId, updates) {
    const data = this._load();
    const idx = data.products.findIndex((p) => p.productId === productId);
    if (idx === -1) return null;
    data.products[idx] = { ...data.products[idx], ...updates, productId };
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
    this._cache = data;
    return data.products[idx];
  }
}

module.exports = { JsonFileProductsProvider };
