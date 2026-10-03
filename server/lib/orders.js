/**
 * Order store — thin delegator.
 *
 * This used to contain the JSON-file order state machine directly. That
 * logic still exists, unchanged, in server/orders/JsonFileOrdersStore.js —
 * it moved there so a second backend (server/orders/SupabaseOrdersStore.js)
 * could sit next to it behind the same interface, chosen by
 * server/orders/index.js based on env config.
 *
 * Kept as a stable import path: server/routes/checkout.js, order.js and
 * admin.js all still `require("../lib/orders")` exactly as before.
 *
 * One real change from before: every function here is now async (returns
 * a Promise), because a real database call can't be synchronous. Every
 * call site already runs inside an asyncHandler-wrapped async route
 * handler, so this only meant adding `await` at each call — no route logic
 * changed.
 */
const orders = require("../orders");

module.exports = {
  createOrder: orders.createOrder,
  getOrder: orders.getOrder,
  getAllOrders: orders.getAllOrders,
  getOrdersByPhone: orders.getOrdersByPhone,
  setStatus: orders.setStatus,
  advanceStatus: orders.advanceStatus,
  setDeliveryOrderId: orders.setDeliveryOrderId,
  getOrderByGatewayOrderId: orders.getOrderByGatewayOrderId,
  updateOrder: orders.updateOrder,
  startDemoProgression: orders.startDemoProgression,
  STATUSES: orders.STATUSES,
  PRE_PAYMENT_STATUSES: orders.PRE_PAYMENT_STATUSES,
};
