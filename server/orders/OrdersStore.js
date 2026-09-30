/**
 * OrdersStore — the interface every order-persistence backend implements.
 * Same Strategy/Adapter shape as ProductsProvider/DeliveryProvider/
 * NotificationProvider. Kept synchronous-shaped where the JSON file store
 * naturally is (createOrder/getOrder/getAllOrders/advanceStatus all return
 * plain values, not promises) so server/routes/checkout.js, order.js and
 * admin.js don't have to change regardless of which store is active —
 * the Supabase store just does its network calls fire-and-forget /
 * best-effort against an in-memory mirror, exactly like
 * GoogleSheetsProductsProvider does for writes. See SupabaseOrdersStore.js
 * for how that trade-off is made safe.
 */
class OrdersStore {
  get name() {
    throw new Error("OrdersStore.name must be implemented by a subclass");
  }

  /** Optional: called once at boot to warm any in-memory mirror. Never required to resolve before use. */
  async init() {}

  createOrder(_args) {
    throw new Error("createOrder() must be implemented by a subclass");
  }
  getOrder(_orderId) {
    throw new Error("getOrder() must be implemented by a subclass");
  }
  getAllOrders(_opts) {
    throw new Error("getAllOrders() must be implemented by a subclass");
  }
  /** All orders placed with a given (already-validated, digits-only) 10-digit phone number, newest first. Powers the "My Orders" lookup. */
  getOrdersByPhone(_phone) {
    throw new Error("getOrdersByPhone() must be implemented by a subclass");
  }
  setStatus(_orderId, _status) {
    throw new Error("setStatus() must be implemented by a subclass");
  }
  advanceStatus(_orderId) {
    throw new Error("advanceStatus() must be implemented by a subclass");
  }

  /**
   * Records the delivery provider's order ID once the (fire-and-forget)
   * delivery-order creation call after checkout resolves — see
   * server/routes/checkout.js. Must be safe to call after the order was
   * already returned to the customer, and must never throw in a way that
   * crashes the timer/promise chain calling it.
   */
  setDeliveryOrderId(_orderId, _deliveryOrderId) {
    throw new Error("setDeliveryOrderId() must be implemented by a subclass");
  }
}

module.exports = { OrdersStore };
