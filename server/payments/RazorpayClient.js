/**
 * The four Razorpay calls DE.25 needs, over plain fetch (no SDK dependency):
 *
 *   createOrder      POST /v1/orders            — amount fixed server-side
 *   fetchPayment     GET  /v1/payments/:id
 *   capturePayment   POST /v1/payments/:id/capture (only if not auto-captured)
 *   listOrderPayments GET /v1/orders/:id/payments — reconcile a missed callback
 *
 * plus the two signature checks that make a payment trustworthy:
 *
 *   checkout signature  HMAC_SHA256(order_id + "|" + payment_id, key_secret)
 *   webhook signature   HMAC_SHA256(raw request body, webhook_secret)
 *
 * Docs: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
 * The key secret and webhook secret never leave the server.
 */
const crypto = require("crypto");

const API_BASE = "https://api.razorpay.com/v1";

class RazorpayApiError extends Error {
  constructor(message, { httpStatus = 0, code = null, description = null } = {}) {
    super(message);
    this.name = "RazorpayApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.description = description;
    this.publicMessage = "The payment gateway didn't respond properly. Please try again in a minute.";
  }
}

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time comparison of two hex strings; false for anything malformed. */
function safeEqualHex(expected, received) {
  if (typeof received !== "string" || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received.toLowerCase(), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyCheckoutSignature({ gatewayOrderId, paymentId, signature, keySecret }) {
  if (!gatewayOrderId || !paymentId || !keySecret) return false;
  return safeEqualHex(hmacHex(keySecret, `${gatewayOrderId}|${paymentId}`), signature);
}

function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!webhookSecret || (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string")) return false;
  return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
}

class RazorpayClient {
  constructor({ keyId, keySecret, fetchImpl = globalThis.fetch, timeoutMs = 12000 }) {
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async _request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new RazorpayApiError(err.name === "AbortError" ? "Razorpay timed out" : `Razorpay unreachable: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_e) {
      // fall through — reported below with the HTTP status
    }
    if (!res.ok) {
      const e = (data && data.error) || {};
      throw new RazorpayApiError(`Razorpay HTTP ${res.status}${e.code ? ` ${e.code}` : ""}${e.description ? `: ${e.description}` : ""}`, {
        httpStatus: res.status,
        code: e.code || null,
        description: e.description || null,
      });
    }
    return data;
  }

  /** amountPaise is an integer number of paise; receipt <= 40 chars; notes <= 15 short pairs. */
  createOrder({ amountPaise, receipt, notes }) {
    return this._request("POST", "/orders", { amount: amountPaise, currency: "INR", receipt: String(receipt).slice(0, 40), notes });
  }

  fetchPayment(paymentId) {
    return this._request("GET", `/payments/${encodeURIComponent(paymentId)}`);
  }

  capturePayment(paymentId, amountPaise) {
    return this._request("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: "INR" });
  }

  async listOrderPayments(gatewayOrderId) {
    const data = await this._request("GET", `/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
    return Array.isArray(data && data.items) ? data.items : [];
  }
}

module.exports = { RazorpayClient, RazorpayApiError, verifyCheckoutSignature, verifyWebhookSignature, hmacHex };
