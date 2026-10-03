/**
 * Borzo API activity log — one entry per real HTTPS exchange with Borzo's
 * servers, written by BorzoClient after the response (or failure) comes
 * back. This is what the owner dashboard's "Borzo API — live activity"
 * panel shows, so the rule is strict: nothing is ever added here except by
 * an actual network call. Demo-provider work never appears in this log.
 *
 * What is recorded: when, which host/endpoint, why (quote, create-order,
 * status-sync…), HTTP status, latency, Borzo's own response body (trimmed),
 * and the request body with phone numbers masked. What is never recorded:
 * the X-DV-Auth-Token header or any other credential.
 *
 * Persisted to data/borzo-activity.json (gitignored — request bodies hold
 * customer addresses) so the log survives restarts.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Overridable so the test suite never writes into the real log.
const LOG_PATH = process.env.BORZO_ACTIVITY_LOG_PATH || path.join(__dirname, "..", "..", "data", "borzo-activity.json");
const MAX_ENTRIES = 300;
const MAX_BODY_CHARS = 6000;

let entries = null;

function load() {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
    entries = Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : [];
  } catch (_err) {
    entries = [];
  }
  return entries;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[borzo] failed to persist activity log:", err.message);
  }
}

/** "+919876543210" -> "+91******3210". Applied to every `phone` key, at any depth. */
function maskPhones(value) {
  if (Array.isArray(value)) return value.map(maskPhones);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/phone/i.test(k) && typeof v === "string" && v.length > 4) {
      out[k] = v.slice(0, 3) + "*".repeat(Math.max(0, v.length - 7)) + v.slice(-4);
    } else {
      out[k] = maskPhones(v);
    }
  }
  return out;
}

/** Keep log entries small: a huge response becomes a truncated string instead. */
function trimBody(body) {
  if (body === undefined || body === null) return null;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length <= MAX_BODY_CHARS) return body;
  return `${text.slice(0, MAX_BODY_CHARS)}… [truncated, ${text.length} chars]`;
}

function recordCall(entry) {
  load();
  const full = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry,
    request: trimBody(maskPhones(entry.request)),
    response: trimBody(maskPhones(entry.response)),
  };
  entries.unshift(full);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  persist();
  return full;
}

function listActivity({ limit = 50 } = {}) {
  return load().slice(0, limit);
}

function activityStats() {
  const all = load();
  const latencies = all.map((e) => e.latencyMs).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const ordersCreated = all.filter((e) => e.endpoint === "/create-order" && e.ok).length;
  return {
    total: all.length,
    succeeded: all.filter((e) => e.ok).length,
    rejected: all.filter((e) => !e.ok && e.outcome === "api_error").length,
    networkErrors: all.filter((e) => e.outcome === "network_error").length,
    ordersCreated,
    medianLatencyMs: median,
    lastCallAt: all.length ? all[0].at : null,
  };
}

/** Test hook. */
function _resetActivity({ deleteFile = false } = {}) {
  entries = [];
  if (deleteFile) {
    try {
      fs.unlinkSync(LOG_PATH);
    } catch (_err) {
      // nothing to delete
    }
  }
}

module.exports = { LOG_PATH, recordCall, listActivity, activityStats, maskPhones, _resetActivity };
