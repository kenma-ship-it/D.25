/**
 * ProductsProvider — the interface every product-catalog backend implements.
 *
 * Same Strategy/Adapter shape as server/delivery/DeliveryProvider.js and
 * server/notifications/NotificationProvider.js: one abstract base class,
 * a Demo implementation that needs no setup, and a real implementation
 * that stays completely inert until it's actually configured.
 *
 * Unlike delivery/notifications (which are naturally async, one-call-per-
 * order operations), the product catalog is read constantly — every page
 * load, every AI Guide answer, every price calculation — so this interface
 * is deliberately SYNCHRONOUS. A provider is expected to keep its own
 * in-memory cache and serve reads from it instantly; refreshing that cache
 * from a remote source (like Google Sheets) is a separate async concern
 * (see refresh()) that runs at boot and on a timer, never on the read path.
 * That is what lets every existing call site (server/lib/pricing.js,
 * server/ai/foodGuide.js, server/routes/products.js, server/routes/admin.js)
 * keep calling these functions exactly as before with zero changes.
 */
class ProductsProvider {
  /** Human-readable name for logs/dashboards, e.g. "json-file" or "google-sheets". */
  get name() {
    throw new Error("ProductsProvider.name must be implemented by a subclass");
  }

  /** Populate/refresh the in-memory cache. Called at boot and periodically for remote backends. */
  async refresh() {
    throw new Error("refresh() must be implemented by a subclass");
  }

  /** @returns {Array<object>} all products (synchronous, served from cache). */
  getAllProducts(_opts) {
    throw new Error("getAllProducts() must be implemented by a subclass");
  }

  getProductById(_productId) {
    throw new Error("getProductById() must be implemented by a subclass");
  }

  getProductsByCategory(_category) {
    throw new Error("getProductsByCategory() must be implemented by a subclass");
  }

  getCategories() {
    throw new Error("getCategories() must be implemented by a subclass");
  }

  /**
   * Persist an admin edit. Must update the in-memory cache synchronously
   * (so the very next read reflects it) even if writing back to the
   * underlying store is itself asynchronous or can fail — a slow/failed
   * write-back must never make the admin UI look like the edit was lost.
   */
  setProduct(_productId, _updates) {
    throw new Error("setProduct() must be implemented by a subclass");
  }
}

module.exports = { ProductsProvider };
