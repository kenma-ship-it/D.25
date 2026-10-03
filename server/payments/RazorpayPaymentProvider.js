/**
 * Razorpay adapter (UPI, cards, netbanking, wallets).
 *
 * Inert until configured: server/payments/index.js only builds this when
 * PAYMENTS_PROVIDER=razorpay and RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are
 * set. The key secret and webhook secret stay server-side; the browser only
 * ever gets the public key id and a Razorpay order id.
 *
 * Trust rules:
 *   - The browser's "payment succeeded" callback is never believed on its
 *     own: its signature is checked (HMAC-SHA256 of "order_id|payment_id"
 *     with the key secret) AND the payment is then fetched from Razorpay's
 *     API, which is the source of truth for amount and status.
 *   - Webhooks are only accepted with a valid X-Razorpay-Signature
 *     (HMAC-SHA256 of the raw request body with RAZORPAY_WEBHOOK_SECRET).
 *
 * Everything leaving this file is normalized to:
 *   { paymentId, gatewayOrderId, status: "paid"|"authorized"|"failed"|"pending"|"refunded",
 *     amountPaise, method, vpa?, bank?, wallet?, errorCode, errorReason, at, orderIdNote }
 */
const crypto = require("crypto");

const API = "https://api.razorpay.com/v1";

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function normalizePayment(p) {
  if (!p || typeof p !== "object") return null;
  const status =
    p.status === "captured" ? "paid" : p.status === "authorized" ? "authorized" : p.status === "failed" ? "failed" : p.status === "refunded" ? "refunded" : "pending";
  return {
    paymentId: p.id,
    gatewayOrderId: p.order_id || null,
    // A refunded payment was captured first — keep it counted as money received.
    status,
    amountPaise: Number(p.amount) || 0,
    refundedPaise: Number(p.amount_refunded) || 0,
    method: p.method || null,
    vpa: p.vpa || null,
    bank: p.bank || null,
    wallet: p.wallet || null,
    errorCode: p.error_code || null,
    errorReason: p.error_description || p.error_reason || null,
    at: p.created_at ? new Date(p.created_at * 1000).toISOString() : new Date().toISOString(),
    orderIdNote: (p.notes && p.notes.orderId) || null,
  };
}

class RazorpayPaymentProvider {
  constructor({ keyId, keySecret, webhookSecret, fetchImpl } = {}) {
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret || "";
    this.fetch = fetchImpl || ((...args) => fetch(...args));
  }

  get name() {
    return "razorpay";
  }
  get isLive() {
    return true;
  }

  async _api(method, path, body) {
    const res = await this.fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = (data && data.error && data.error.description) || `HTTP ${res.status}`;
      throw new Error(`Razorpay ${method} ${path} failed: ${reason}`);
    }
    return data;
  }

  async createPayment(order, amountPaise) {
    const rz = await this._api("POST", "/orders", {
      amount: amountPaise,
      currency: "INR",
      receipt: `DE25-${order.token}-${order.orderId.slice(0, 8)}`,
      notes: { orderId: order.orderId, token: order.token },
    });
    return {
      gatewayOrderId: rz.id,
      checkout: {
        provider: "razorpay",
        keyId: this.keyId,
        gatewayOrderId: rz.id,
        amountPaise,
        currency: "INR",
        name: "DE.25 by Harshali",
        description: `Order ${order.token}`,
        prefill: { name: order.customer.name, contact: `+91${order.customer.phone}`, email: order.customer.email || undefined },
        notes: { orderId: order.orderId },
      },
    };
  }

  /** Signature Razorpay Checkout hands the browser after a successful payment. */
  verifyCheckoutSignature({ gatewayOrderId, paymentId, signature }) {
    if (!gatewayOrderId || !paymentId || !signature) return false;
    return safeEqualHex(hmacHex(this.keySecret, `${gatewayOrderId}|${paymentId}`), signature);
  }

  async getPayment(paymentId) {
    return normalizePayment(await this._api("GET", `/payments/${encodeURIComponent(paymentId)}`));
  }

  /** Every payment attempt Razorpay has against one of our orders — used to reconcile. */
  async listOrderPayments(gatewayOrderId) {
    const data = await this._api("GET", `/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
    return (data && Array.isArray(data.items) ? data.items : []).map(normalizePayment).filter(Boolean);
  }

  verifyWebhook(rawBody, signature) {
    if (!this.webhookSecret || !rawBody) return false;
    return safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature);
  }

  /** Webhook body -> { payment?, refund? } in normalized form, or null for events we don't use. */
  parseWebhook(body) {
    const event = body && body.event;
    const payload = (body && body.payload) || {};
    const payment = payload.payment && payload.payment.entity ? normalizePayment(payload.payment.entity) : null;
    if (typeof event !== "string") return null;
    if (event.startsWith("refund.")) {
      const r = payload.refund && payload.refund.entity;
      if (!r) return null;
      return {
        payment,
        refund: {
          refundId: r.id,
          paymentId: r.payment_id,
          amountPaise: Number(r.amount) || 0,
          status: event === "refund.failed" ? "failed" : event === "refund.processed" ? "processed" : "pending",
          at: r.created_at ? new Date(r.created_at * 1000).toISOString() : new Date().toISOString(),
        },
      };
    }
    if (event.startsWith("payment.") || event === "order.paid") return payment ? { payment } : null;
    return null;
  }
}

module.exports = { RazorpayPaymentProvider, normalizePayment, hmacHex };
