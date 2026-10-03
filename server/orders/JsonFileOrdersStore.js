/**
 * The default, zero-setup order store: data/orders.json, written
 * synchronously after every create/status change. Moved here unchanged
 * from what used to be all of server/lib/orders.js, so it can sit next to
 * SupabaseOrdersStore.js behind the same OrdersStore interface (see
 * server/orders/index.js for how the active one is chosen).
 *
 * This file contains customer PII (name, phone, email, address) — it's
 * listed in .gitignore and must never be committed or shared.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { OrdersStore } = require("./OrdersStore");

const ORDERS_PATH = path.join(__dirname, "..", "..", "data", "orders.json");

// Fulfilment steps, in order. An order only enters this sequence once its
// payment is confirmed; before that it is AWAITING_PAYMENT, and an order
// whose payment never arrives ends as CANCELLED (server/payments/service.js).
const STATUSES = [
  "ORDER_PLACED",
  "PAYMENT_CONFIRMED",
  "PREPARING",
  "READY_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];
const PRE_PAYMENT_STATUSES = ["AWAITING_PAYMENT", "CANCELLED"];

function generateToken() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const letter = letters[crypto.randomInt(letters.length)];
  const digits = String(crypto.randomInt(0, 100)).padStart(2, "0");
  return `${letter}${digits}`;
}

function generatePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

class JsonFileOrdersStore extends OrdersStore {
  constructor() {
    super();
    this.orders = new Map();
    this._loadFromDisk();
  }

  get name() {
    return "json-file";
  }

  _loadFromDisk() {
    try {
      const raw = fs.readFileSync(ORDERS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((order) => {
          if (order && typeof order.orderId === "string") this.orders.set(order.orderId, order);
        });
      }
    } catch (_err) {
      // No file yet (first run) or unreadable — start empty. Never crash
      // boot over this; an order-history file is not required to run.
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(ORDERS_PATH), { recursive: true });
      fs.writeFileSync(ORDERS_PATH, JSON.stringify(Array.from(this.orders.values()), null, 2), "utf8");
    } catch (err) {
      // A failed write must never break checkout for the customer — the
      // order still exists in memory for this process.
      // eslint-disable-next-line no-console
      console.error("[orders] failed to persist orders.json:", err.message);
    }
  }

  // These are all synchronous under the hood (memory + a local file) but
  // declared async to satisfy the same OrdersStore interface
  // SupabaseOrdersStore implements with real network calls — see that
  // file's header and server/orders/OrdersStore.js for why the interface
  // is Promise-based even though this implementation never actually awaits
  // anything.
  async createOrder({ customer, address, pricing, paymentMethod, deliveryOrderId }) {
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Nothing is confirmed until the payment gateway says the money arrived.
    const initialStatus = "AWAITING_PAYMENT";

    const order = {
      orderId,
      token: generateToken(),
      pin: generatePin(),
      customer,
      address,
      lines: pricing.lines,
      subtotal: pricing.subtotal,
      deliveryFee: pricing.deliveryFee,
      tax: pricing.tax,
      total: pricing.total,
      deliveryQuote: pricing.deliveryQuote,
      paymentMethod,
      deliveryOrderId: deliveryOrderId || null,
      payment: null,
      status: initialStatus,
      statusHistory: [{ status: initialStatus, at: now }],
      createdAt: now,
    };

    this.orders.set(orderId, order);
    this._persist();
    return order;
  }

  async getOrderByGatewayOrderId(gatewayOrderId) {
    if (!gatewayOrderId) return null;
    for (const order of this.orders.values()) {
      if (order.payment && order.payment.gatewayOrderId === gatewayOrderId) return order;
    }
    return null;
  }

  /** Replaces `payment` and/or moves `status` (appending to statusHistory) in one write. */
  async updateOrder(orderId, { payment, status, customer } = {}) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (payment !== undefined) order.payment = payment;
    if (customer !== undefined) order.customer = customer;
    if (status && status !== order.status && (STATUSES.includes(status) || PRE_PAYMENT_STATUSES.includes(status))) {
      order.status = status;
      order.statusHistory.push({ status, at: new Date().toISOString() });
    }
    this._persist();
    return order;
  }

  startDemoProgression(orderId) {
    if (this.orders.has(orderId)) this._scheduleDemoProgression(orderId);
  }

  async getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  async getAllOrders({ limit } = {}) {
    const all = Array.from(this.orders.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return typeof limit === "number" ? all.slice(0, limit) : all;
  }

  async getOrdersByPhone(phone) {
    const normalized = String(phone || "").replace(/\D/g, "");
    if (!normalized) return [];
    return Array.from(this.orders.values())
      .filter((order) => String(order.customer && order.customer.phone).replace(/\D/g, "") === normalized)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async setStatus(orderId, status) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (!STATUSES.includes(status) && !PRE_PAYMENT_STATUSES.includes(status)) return order;
    order.status = status;
    order.statusHistory.push({ status, at: new Date().toISOString() });
    this._persist();
    return order;
  }

  async advanceStatus(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const currentIndex = STATUSES.indexOf(order.status);
    if (currentIndex === -1 || currentIndex >= STATUSES.length - 1) return order;
    return this.setStatus(orderId, STATUSES[currentIndex + 1]);
  }

  async setDeliveryOrderId(orderId, deliveryOrderId) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    order.deliveryOrderId = deliveryOrderId;
    this._persist();
    return order;
  }

  /**
   * Demo-only: advances a freshly-placed order through the remaining
   * statuses on a timer, since there's no real kitchen/courier in the loop
   * yet. Only runs for orders created in this process — see
   * server/lib/orders.js's original header comment (preserved in
   * server/orders/index.js) for the full rationale.
   */
  _scheduleDemoProgression(orderId) {
    const from = STATUSES.indexOf(this.orders.get(orderId).status);
    if (from === -1) return;
    const remaining = STATUSES.slice(from + 1);
    let delay = 6000;
    remaining.forEach((status) => {
      const timer = setTimeout(() => {
        const o = this.orders.get(orderId);
        // Skip if the owner has already moved it past this step by hand.
        if (o && STATUSES.indexOf(o.status) > -1 && STATUSES.indexOf(o.status) < STATUSES.indexOf(status)) this.setStatus(orderId, status);
      }, delay);
      // Demo-only timers must never keep the Node process (or a test run)
      // alive on their own — a real deployment stays up because of the
      // HTTP server, not these.
      if (timer.unref) timer.unref();
      delay += 6000 + Math.round(Math.random() * 4000);
    });
  }
}

module.exports = { JsonFileOrdersStore, STATUSES, PRE_PAYMENT_STATUSES };
