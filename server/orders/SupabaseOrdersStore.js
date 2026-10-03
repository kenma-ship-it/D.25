/**
 * Supabase Postgres-backed order store, via PostgREST (Supabase's auto-
 * generated REST API over the database) using the service role key —
 * see server/lib/supabaseRest.js for why there's no @supabase/supabase-js
 * dependency, and why the service role key is safe here (server-only,
 * bypasses Row Level Security, never sent to the browser).
 *
 * Inert until fully configured (same rule as every other real provider in
 * this codebase): server/orders/index.js only builds this once
 * SUPABASE_ORDERS_ENABLED is true and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are both set.
 *
 * --- One-time setup (see also supabase/schema.sql and the README) ---
 *   1. Create a Supabase project (supabase.com) — this also gives you the
 *      admin-login Supabase project if you're using SUPABASE_AUTH_PROVIDER
 *      too; they can be the same project.
 *   2. Run supabase/schema.sql in the SQL editor to create the `orders`
 *      table with Row Level Security enabled and no public policies (the
 *      service role key bypasses RLS regardless, which is intentional:
 *      customer order data should never be reachable via the anon key).
 *   3. Copy the project URL and the `service_role` secret (Project
 *      Settings -> API) into SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
 *
 * Table <-> app-object mapping is a flat camelCase<->snake_case rename;
 * nested structures (customer, address, lines, deliveryQuote,
 * statusHistory) are stored as-is in jsonb columns rather than normalized
 * into separate tables — this keeps the schema a direct match for the
 * order object every route already works with, same reasoning
 * server/lib/orders.js's original header gave for the JSON-file shape.
 */
const crypto = require("crypto");
const { OrdersStore } = require("./OrdersStore");
const { restRequest } = require("../lib/supabaseRest");

const { STATUSES, ALL_STATUSES, AWAITING_PAYMENT } = require("./statuses");

const TABLE = "orders";

function generateToken() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const letter = letters[crypto.randomInt(letters.length)];
  const digits = String(crypto.randomInt(0, 100)).padStart(2, "0");
  return `${letter}${digits}`;
}

function generatePin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

function toRow(order) {
  return {
    order_id: order.orderId,
    token: order.token,
    pin: order.pin,
    customer: order.customer,
    address: order.address,
    lines: order.lines,
    subtotal: order.subtotal,
    delivery_fee: order.deliveryFee,
    tax: order.tax,
    total: order.total,
    delivery_quote: order.deliveryQuote,
    payment_method: order.paymentMethod,
    payment: order.payment || null,
    customer_phone_verified: Boolean(order.customerPhoneVerified),
    delivery_order_id: order.deliveryOrderId,
    delivery: order.delivery || null,
    is_sample: Boolean(order.isSample),
    status: order.status,
    status_history: order.statusHistory,
    created_at: order.createdAt,
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    orderId: row.order_id,
    token: row.token,
    pin: row.pin,
    customer: row.customer,
    address: row.address,
    lines: row.lines,
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    tax: row.tax,
    total: row.total,
    deliveryQuote: row.delivery_quote,
    paymentMethod: row.payment_method,
    payment: row.payment || null,
    customerPhoneVerified: Boolean(row.customer_phone_verified),
    deliveryOrderId: row.delivery_order_id,
    delivery: row.delivery || null,
    isSample: Boolean(row.is_sample),
    status: row.status,
    statusHistory: row.status_history,
    createdAt: row.created_at,
  };
}

class SupabaseOrdersStore extends OrdersStore {
  constructor() {
    super();
    this._timers = new Set();
  }

  get name() {
    return "supabase";
  }

  async createOrder({ customer, address, pricing, paymentMethod, payment = null, customerPhoneVerified = false, deliveryOrderId, isSample = false }) {
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    // Every order waits for a confirmed payment before anything else
    // happens to it — see server/payments/index.js.
    const initialStatus = AWAITING_PAYMENT;

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
      // { method, status: pending|paid|expired|failed, amountPaise, … }
      payment,
      // Whether the customer proved this WhatsApp number at checkout — the
      // receipt goes out after payment, so the answer has to be kept.
      customerPhoneVerified: Boolean(customerPhoneVerified),
      deliveryOrderId: deliveryOrderId || null,
      delivery: null,
      isSample: Boolean(isSample),
      status: initialStatus,
      statusHistory: [{ status: initialStatus, at: now }],
      createdAt: now,
    };

    const rows = await restRequest(TABLE, {
      method: "POST",
      body: toRow(order),
      prefer: "return=representation",
    });
    return fromRow(Array.isArray(rows) ? rows[0] : rows) || order;
  }

  async getOrder(orderId) {
    const rows = await restRequest(TABLE, { query: { order_id: `eq.${orderId}`, select: "*" } });
    return fromRow(Array.isArray(rows) ? rows[0] : null);
  }

  async getAllOrders({ limit } = {}) {
    const query = { select: "*", order: "created_at.desc" };
    if (typeof limit === "number") query.limit = String(limit);
    const rows = await restRequest(TABLE, { query });
    return (Array.isArray(rows) ? rows : []).map(fromRow);
  }

  async getOrdersByPhone(phone) {
    const normalized = String(phone || "").replace(/\D/g, "");
    if (!normalized) return [];
    // `customer` is a jsonb column — ->> extracts the phone field as text
    // for an equality filter; supabase/schema.sql adds a matching
    // expression index (orders_customer_phone_idx) so this stays fast.
    const rows = await restRequest(TABLE, {
      query: { "customer->>phone": `eq.${normalized}`, select: "*", order: "created_at.desc" },
    });
    return (Array.isArray(rows) ? rows : []).map(fromRow);
  }

  async setStatus(orderId, status) {
    if (!ALL_STATUSES.includes(status)) return this.getOrder(orderId);
    const existing = await this.getOrder(orderId);
    if (!existing) return null;
    const statusHistory = [...existing.statusHistory, { status, at: new Date().toISOString() }];
    const rows = await restRequest(TABLE, {
      method: "PATCH",
      query: { order_id: `eq.${orderId}` },
      body: { status, status_history: statusHistory },
      prefer: "return=representation",
    });
    return fromRow(Array.isArray(rows) ? rows[0] : null);
  }

  async advanceStatus(orderId) {
    const order = await this.getOrder(orderId);
    if (!order) return null;
    const currentIndex = STATUSES.indexOf(order.status);
    if (currentIndex === -1 || currentIndex >= STATUSES.length - 1) return order;
    return this.setStatus(orderId, STATUSES[currentIndex + 1]);
  }

  async setDeliveryOrderId(orderId, deliveryOrderId) {
    const rows = await restRequest(TABLE, {
      method: "PATCH",
      query: { order_id: `eq.${orderId}` },
      body: { delivery_order_id: deliveryOrderId },
      prefer: "return=representation",
    });
    return fromRow(Array.isArray(rows) ? rows[0] : null);
  }

  async setDelivery(orderId, delivery) {
    const body = { delivery };
    if (delivery && delivery.deliveryOrderId) body.delivery_order_id = delivery.deliveryOrderId;
    const rows = await restRequest(TABLE, {
      method: "PATCH",
      query: { order_id: `eq.${orderId}` },
      body,
      prefer: "return=representation",
    });
    return fromRow(Array.isArray(rows) ? rows[0] : null);
  }

  async setPayment(orderId, payment, { status, onlyIfStatus } = {}) {
    const existing = await this.getOrder(orderId);
    if (!existing) return null;
    if (onlyIfStatus && existing.status !== onlyIfStatus) return null;
    const body = { payment };
    if (status && status !== existing.status && ALL_STATUSES.includes(status)) {
      body.status = status;
      body.status_history = [...existing.statusHistory, { status, at: new Date().toISOString() }];
    }
    // The status filter makes this a compare-and-set in Postgres too: if
    // another server instance confirmed the payment first, no row matches
    // and this returns null.
    const query = { order_id: `eq.${orderId}` };
    if (onlyIfStatus) query.status = `eq.${onlyIfStatus}`;
    const rows = await restRequest(TABLE, { method: "PATCH", query, body, prefer: "return=representation" });
    return fromRow(Array.isArray(rows) ? rows[0] : null);
  }

  async startDemoProgression(orderId) {
    const order = await this.getOrder(orderId);
    if (order) this._scheduleDemoProgression(orderId, order.status);
  }

  /**
   * Same demo-only auto-progression as JsonFileOrdersStore, for the same
   * reason: there's no real courier system yet. This only advances orders
   * created in the current process — a restart relies on the owner
   * dashboard's manual "advance status" action for older orders, exactly
   * like the JSON store (a real Borzo webhook replaces this entirely once
   * delivery is actually live).
   */
  _scheduleDemoProgression(orderId, currentStatus) {
    const remaining = STATUSES.slice(STATUSES.indexOf(currentStatus) + 1);
    let delay = 6000;
    remaining.forEach((status) => {
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        this.setStatus(orderId, status).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[orders] demo auto-progression failed for ${orderId} -> ${status}:`, err.message);
        });
      }, delay);
      // Demo-only timers must never keep the Node process alive on their
      // own — see JsonFileOrdersStore's identical comment.
      if (timer.unref) timer.unref();
      this._timers.add(timer);
      delay += 6000 + Math.round(Math.random() * 4000);
    });
  }
}

module.exports = { SupabaseOrdersStore, STATUSES };
