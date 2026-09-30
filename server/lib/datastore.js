/**
 * Product datastore — thin delegator.
 *
 * This used to contain the JSON-file read/write logic directly. That logic
 * still exists, unchanged, in server/products/JsonFileProductsProvider.js —
 * it moved there so a second backend (server/products/GoogleSheetsProductsProvider.js)
 * could sit next to it behind the same interface, chosen by
 * server/products/index.js based on env config (see that file's header).
 *
 * This file is kept as a stable import path: server/lib/pricing.js,
 * server/ai/foodGuide.js, server/routes/products.js and
 * server/routes/admin.js all still `require("./datastore")` /
 * `require("../lib/datastore")` exactly as before — none of them needed to
 * change when the catalog became pluggable.
 */
const products = require("../products");

module.exports = {
  getAllProducts: products.getAllProducts,
  getProductById: products.getProductById,
  getProductsByCategory: products.getProductsByCategory,
  getCategories: products.getCategories,
  setProduct: products.setProduct,
  reload: products.reload,
};
