const { DeliveryProvider } = require("./DeliveryProvider");
const { HOSTS, baseUrlFor, DEFAULT_VERSION } = require("./borzoConfig");
const activity = require("./borzoActivity");

/**
 * BorzoDeliveryProvider — Borzo Business API v1.8 (India).
 *
 * Docs:  https://borzodelivery.com/in/business-api/doc
 * Auth:  X-DV-Auth-Token header. The token only ever lives in .env and in
 *        this process; it is never logged, never stored in the activity
 *        log, and never sent to the browser.
 *
 * Endpoints used:
 *   POST /calculate-order   price check; books nothing, charges nothing
 *   POST /create-order      books the courier
 *   GET  /orders?order_id[] status, courier and tracking link (batched)
 *   POST /cancel-order      cancels a booking
 *
 * Only constructed by the factory in ./index.js once every switch is set
 * (see ./borzoConfig.js). Route code must go through getDeliveryProvider().
 *
 * Every request — success, Borzo rejection or network failure — is written
 * to the Borzo activity log (./borzoActivity.js), which is what the owner
 * dashboard shows as proof the integration is talking to Borzo for real.
 */

const DEFAULT_TIMEOUT_MS = 20000;
// Borzo's quote has no ETA for an as-soon-as-possible order until a courier
// accepts it, so the checkout falls back to a typical intra-city figure.
const DEFAULT_ETA_MINUTES = 60;

// Errors that will fail identically on a second attempt.
const PERMANENT_ERRORS = [
  "required_auth_token",
  "invalid_auth_token",
  "access_denied",
  "insufficient_funds",
  "not_enough_money",
  "insufficient_balance",
];

const STATUS_LABELS = {
  searching: "Looking for a courier",
  courier_assigned: "Courier assigned",
  picked_up: "Courier picked up the order",
  delivered: "Delivered",
  cancelled: "Delivery cancelled",
};

class BorzoApiError extends Error {
  constructor(message, { httpStatus = 0, errors = [], parameterErrors = null, retryable = false, publicMessage } = {}) {
    super(message);
    this.name = "BorzoApiError";
    this.httpStatus = httpStatus;
    this.errors = errors;
    this.parameterErrors = parameterErrors;
    this.retryable = retryable;
    // Safe to show a customer. Never contains Borzo's raw error codes.
    this.publicMessage = publicMessage || null;
  }
}

/** India: Borzo wants a full international number. */
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

/** Borzo sends money as strings ("85.00"). */
function toRupees(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Borzo order status: new | available | active | delayed | completed |
 * canceled (plus draft/reactivated). Finer detail comes from per-point
 * courier_visit_datetime, which is only set once the courier has actually
 * been there — never inferred from a promised arrival window.
 */
function mapBorzoStatus(borzoOrder) {
  const s = String((borzoOrder && borzoOrder.status) || "").toLowerCase();
  const points = (borzoOrder && borzoOrder.points) || [];
  const pickup = points[0];
  const dropoff = points[points.length - 1];

  if (s === "completed") return "delivered";
  if (s === "canceled" || s === "cancelled") return "cancelled";
  if (dropoff && dropoff !== pickup && dropoff.courier_visit_datetime) return "delivered";
  if (pickup && pickup.courier_visit_datetime) return "picked_up";
  if (s === "active") return "courier_assigned";
  return "searching";
}

function mapCourier(borzoOrder) {
  const c = borzoOrder && borzoOrder.courier;
  if (!c || !c.courier_id) return null;
  return {
    name: [c.name, c.surname].filter(Boolean).join(" ") || "Borzo courier",
    phone: c.phone || null,
    photoUrl: c.photo_url || null,
  };
}

function trackingUrlOf(borzoOrder) {
  const points = (borzoOrder && borzoOrder.points) || [];
  const withUrl = points
    .slice()
    .reverse()
    .find((p) => p.tracking_url);
  return withUrl ? withUrl.tracking_url : null;
}

function etaMinutesOf(borzoOrder, now = Date.now()) {
  const points = (borzoOrder && borzoOrder.points) || [];
  const dropoff = points[points.length - 1];
  if (!dropoff) return null;
  const when = dropoff.required_finish_datetime || dropoff.arrival_finish_datetime || dropoff.required_start_datetime;
  const t = when ? Date.parse(when) : NaN;
  if (!Number.isFinite(t)) return null;
  const minutes = Math.ceil((t - now) / 60000);
  return minutes > 0 && minutes < 12 * 60 ? minutes : null;
}

function formatAddress(address) {
  return [address.house, address.street, address.area, address.city, address.pincode].filter(Boolean).join(", ");
}

function describeErrors(json) {
  const parts = [];
  if (json && Array.isArray(json.errors) && json.errors.length) parts.push(json.errors.join(", "));
  if (json && json.parameter_errors && Object.keys(json.parameter_errors).length) {
    parts.push(
      Object.entries(json.parameter_errors)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" | ")
    );
  }
  return parts.join(" — ");
}

/** One-line, human-readable outcome for the activity log. */
function summarize(endpoint, ok, json, httpStatus) {
  if (!ok) return describeErrors(json) || `HTTP ${httpStatus}`;
  const o = (json && json.order) || {};
  if (endpoint === "/calculate-order") {
    const warn = Array.isArray(json.warnings) && json.warnings.length ? ` (warnings: ${json.warnings.join(", ")})` : "";
    return `Quote ₹${o.payment_amount ?? o.delivery_fee_amount ?? "?"}${warn}`;
  }
  if (endpoint === "/create-order") return `Borzo order #${o.order_id} created — status "${o.status}"`;
  if (endpoint === "/cancel-order") return `Borzo order #${o.order_id ?? "?"} cancelled`;
  if (endpoint === "/orders") {
    const list = (json && json.orders) || [];
    if (!list.length) return "No matching orders";
    return list.map((x) => `#${x.order_id} ${x.status}`).join(", ");
  }
  return `HTTP ${httpStatus}`;
}

/**
 * One HTTPS call to Borzo, always recorded in the activity log. Never
 * throws — returns { ok, httpStatus, json, latencyMs, error } so callers
 * (including the token-less connection check) decide what a failure means.
 */
async function borzoRequest({
  method,
  endpoint,
  body,
  token,
  environment,
  version = DEFAULT_VERSION,
  purpose,
  deOrderId = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const url = new URL(baseUrlFor(environment, version) + endpoint);
  const headers = { Accept: "application/json" };
  if (token) headers["X-DV-Auth-Token"] = token;
  const init = { method, headers };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body || {});
  } else if (body) {
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(`${k}[]`, item));
      else if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  // A clearable timer rather than AbortSignal.timeout(), which keeps a
  // handle alive for its full duration even after the request settles.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  init.signal = ac.signal;

  const started = Date.now();
  let res;
  let text = "";
  let networkError = null;
  try {
    res = await fetchImpl(url, init);
    text = await res.text();
  } catch (err) {
    networkError = ac.signal.aborted ? `Borzo did not respond within ${Math.round(timeoutMs / 1000)}s` : err.message;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;

  const logBase = {
    environment,
    host: HOSTS[environment],
    method,
    endpoint,
    path: url.pathname + url.search,
    purpose,
    authenticated: Boolean(token),
    deOrderId,
    latencyMs,
    request: method === "POST" ? body || {} : null,
  };

  if (networkError) {
    activity.recordCall({ ...logBase, httpStatus: 0, ok: false, outcome: "network_error", summary: networkError, response: null });
    return {
      ok: false,
      httpStatus: 0,
      json: null,
      latencyMs,
      error: new BorzoApiError(`Network error calling Borzo: ${networkError}`, { retryable: true }),
    };
  }

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_err) {
    activity.recordCall({
      ...logBase,
      httpStatus: res.status,
      ok: false,
      outcome: "network_error",
      summary: `Non-JSON response (HTTP ${res.status})`,
      response: text.slice(0, 500),
    });
    return {
      ok: false,
      httpStatus: res.status,
      json: null,
      latencyMs,
      error: new BorzoApiError(`Borzo returned non-JSON (HTTP ${res.status})`, { httpStatus: res.status, retryable: true }),
    };
  }

  const ok = res.ok && json.is_successful !== false;
  const errors = Array.isArray(json.errors) ? json.errors.map(String) : [];
  const createdId = endpoint === "/create-order" && ok && json.order ? String(json.order.order_id) : null;
  activity.recordCall({
    ...logBase,
    httpStatus: res.status,
    ok,
    outcome: ok ? "success" : "api_error",
    errors,
    parameterErrors: json.parameter_errors || null,
    warnings: json.warnings || [],
    borzoOrderId: createdId,
    summary: summarize(endpoint, ok, json, res.status),
    response: json,
  });

  if (ok) return { ok: true, httpStatus: res.status, json, latencyMs, error: null };

  const retryable = !errors.some((c) => PERMANENT_ERRORS.includes(c)) && (res.status === 429 || res.status >= 500);
  const addressProblem = JSON.stringify(json.parameter_errors || {}).includes("points");
  return {
    ok: false,
    httpStatus: res.status,
    json,
    latencyMs,
    error: new BorzoApiError(`Borzo rejected ${endpoint}: ${describeErrors(json) || `HTTP ${res.status}`}`, {
      httpStatus: res.status,
      errors,
      parameterErrors: json.parameter_errors || null,
      retryable,
      publicMessage: addressProblem
        ? "We couldn't arrange delivery to that address. Please check the house, street, area and pincode."
        : null,
    }),
  };
}

class BorzoDeliveryProvider extends DeliveryProvider {
  constructor({
    token,
    environment = "test",
    version = DEFAULT_VERSION,
    vehicleTypeId = 8,
    pickup = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl,
  } = {}) {
    super();
    if (!token) throw new Error("BorzoDeliveryProvider requires a Borzo API token");
    if (!pickup.address) throw new Error("BorzoDeliveryProvider requires a pickup address");
    if (!HOSTS[environment]) throw new Error(`Unknown Borzo environment "${environment}"`);
    this._token = token;
    this.environment = environment;
    this.version = version;
    this.vehicleTypeId = vehicleTypeId;
    this.pickup = pickup;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || ((...args) => fetch(...args));
  }

  get name() {
    return "borzo";
  }

  get baseUrl() {
    return baseUrlFor(this.environment, this.version);
  }

  /** Calls Borzo; retries once only when a second attempt could genuinely differ and can't double-book. */
  async _call(method, endpoint, body, { purpose, deOrderId, retry = false } = {}) {
    const attempt = () =>
      borzoRequest({
        method,
        endpoint,
        body,
        token: this._token,
        environment: this.environment,
        version: this.version,
        purpose,
        deOrderId,
        timeoutMs: this.timeoutMs,
        fetchImpl: this._fetch,
      });
    let r = await attempt();
    if (!r.ok && retry && r.error.retryable) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      r = await attempt();
    }
    if (!r.ok) throw r.error;
    return r.json;
  }

  _orderPayload({ orderId, token, address, customer, lines, isSample = false }) {
    const ref = token ? `DE25-${token}` : "DE.25";
    const items = (lines || []).map((l) => `${l.qty}x ${l.name}`).join(", ");

    // A sample order must never put a real stranger's phone in front of a
    // courier: its drop-off contact is the shop's own number, and Borzo's
    // SMS notifications are switched off for it.
    let dropContact;
    if (isSample) dropContact = { name: `Sample order (${customer ? customer.name : "test"})`, phone: normalizePhone(this.pickup.phone) };
    else if (customer) dropContact = { name: customer.name, phone: normalizePhone(customer.phone) };

    const payload = {
      type: "standard",
      matter: `${isSample ? "[SAMPLE] " : ""}Cake order ${ref}${items ? ` — ${items}` : ""}. Fragile, keep flat.`.slice(0, 500),
      vehicle_type_id: this.vehicleTypeId,
      total_weight_kg: 2,
      is_client_notification_enabled: !isSample,
      is_contact_person_notification_enabled: !isSample,
      points: [
        {
          address: this.pickup.address,
          contact_person: { name: this.pickup.name || "DE.25", phone: normalizePhone(this.pickup.phone) },
          note: `Collect ${ref} from the DE.25 counter.`,
        },
        {
          address: formatAddress(address),
          contact_person: dropContact,
          // Borzo caps this at 32 chars — a dash-less UUID is exactly 32.
          client_order_id: orderId ? String(orderId).replace(/-/g, "").slice(0, 32) : undefined,
          note: address.landmark ? `Landmark: ${address.landmark}` : undefined,
        },
      ],
    };
    // Drop undefined keys so Borzo never sees `"contact_person": null`.
    return JSON.parse(JSON.stringify(payload));
  }

  _deliveryFromBorzo(o) {
    const status = mapBorzoStatus(o);
    return {
      provider: this.name,
      environment: this.environment,
      isLive: true,
      deliveryOrderId: o.order_id != null ? String(o.order_id) : null,
      borzoStatus: o.status || null,
      status,
      statusLabel: STATUS_LABELS[status],
      trackingUrl: trackingUrlOf(o),
      courier: mapCourier(o),
      feeRupees: toRupees(o.payment_amount ?? o.delivery_fee_amount),
    };
  }

  async getDeliveryQuote(address) {
    const json = await this._call("POST", "/calculate-order", this._orderPayload({ address }), {
      purpose: "quote",
      retry: true,
    });
    const o = json.order || {};
    const feeRupees = toRupees(o.payment_amount ?? o.delivery_fee_amount);
    if (feeRupees === null) throw new BorzoApiError("Borzo's quote did not include a price");
    return {
      provider: this.name,
      environment: this.environment,
      feeRupees,
      etaMinutes: etaMinutesOf(o) ?? DEFAULT_ETA_MINUTES,
      isLive: true,
      warnings: json.warnings || [],
    };
  }

  /**
   * Never retried automatically: Borzo has no idempotency key, so a
   * timed-out create-order may still have booked a courier, and a blind
   * retry could book a second one.
   */
  async createDeliveryOrder({ orderId, token, address, customer, lines, isSample = false }) {
    const json = await this._call(
      "POST",
      "/create-order",
      this._orderPayload({ orderId, token, address, customer, lines, isSample }),
      { purpose: isSample ? "sample-order" : "create-order", deOrderId: orderId }
    );
    return this._deliveryFromBorzo(json.order || {});
  }

  /** Status for many orders in ONE request — what the background sync uses. */
  async getDeliveryStatuses(deliveryOrderIds, { purpose = "status-sync" } = {}) {
    const ids = deliveryOrderIds.filter(Boolean).map(String);
    if (!ids.length) return {};
    const json = await this._call("GET", "/orders", { order_id: ids }, { purpose, retry: true });
    const byId = {};
    for (const o of json.orders || []) byId[String(o.order_id)] = this._deliveryFromBorzo(o);
    return byId;
  }

  async getDeliveryStatus(deliveryOrderId) {
    const byId = await this.getDeliveryStatuses([deliveryOrderId], { purpose: "status" });
    const found = byId[String(deliveryOrderId)];
    if (!found) throw new BorzoApiError(`Borzo has no order #${deliveryOrderId} on this account`);
    return found;
  }

  async cancelDelivery(deliveryOrderId) {
    await this._call("POST", "/cancel-order", { order_id: Number(deliveryOrderId) }, { purpose: "cancel" });
    return { provider: this.name, environment: this.environment, cancelled: true, isLive: true, deliveryOrderId: String(deliveryOrderId) };
  }

  async trackDelivery(deliveryOrderId) {
    const d = await this.getDeliveryStatus(deliveryOrderId);
    return { provider: this.name, trackingUrl: d.trackingUrl, status: d.status, isLive: true, environment: this.environment };
  }
}

module.exports = {
  BorzoDeliveryProvider,
  BorzoApiError,
  borzoRequest,
  normalizePhone,
  mapBorzoStatus,
  mapCourier,
  trackingUrlOf,
  etaMinutesOf,
  formatAddress,
  STATUS_LABELS,
};
