/**
 * Live connection check: one real POST /calculate-order to EACH Borzo host
 * (sandbox and production), in parallel, right now. Every exchange lands in
 * the activity log with its real HTTP status, Borzo's real JSON reply and
 * the measured latency — this is the proof that the integration talks to
 * Borzo's actual servers, not a mock.
 *
 * The token (if any) is only ever sent to the host of the configured
 * environment. The other host gets a token-less probe, which Borzo answers
 * with `required_auth_token`: proof the host is up and enforcing auth,
 * without ever sending a sandbox secret to production or vice versa.
 *
 * calculate-order is a price check only — it never books a courier and
 * never charges anything, on either host.
 */
const { HOSTS } = require("./borzoConfig");
const { resolveBorzoConfig } = require("./borzoConfig");
const { borzoRequest } = require("./BorzoDeliveryProvider");

const FALLBACK_PICKUP = "Ghansoli, Navi Mumbai, Maharashtra 400701";
const SAMPLE_DROPOFF = "Sector 17, Palm Beach Road, Vashi, Navi Mumbai, Maharashtra 400703";

function checkPayload(cfg) {
  return {
    matter: "Connection check — cake (price check only, no booking)",
    vehicle_type_id: cfg.vehicleTypeId,
    total_weight_kg: 2,
    points: [{ address: cfg.pickup.address || FALLBACK_PICKUP }, { address: SAMPLE_DROPOFF }],
  };
}

function verdictFor({ authenticated, result }) {
  if (result.httpStatus === 0) {
    return { reachable: false, verdict: `Unreachable — ${result.error ? result.error.message : "no response"}` };
  }
  const errors = (result.json && Array.isArray(result.json.errors) && result.json.errors) || [];
  if (result.ok) {
    const o = (result.json && result.json.order) || {};
    return { reachable: true, verdict: `Authenticated — live quote ₹${o.payment_amount ?? o.delivery_fee_amount ?? "?"}` };
  }
  if (errors.includes("required_auth_token")) {
    return { reachable: true, verdict: "Reachable — Borzo answered and is enforcing authentication (no token sent)" };
  }
  if (errors.includes("invalid_auth_token")) {
    return { reachable: true, verdict: "Reachable — but Borzo rejected the token (is it from this environment's dashboard?)" };
  }
  return {
    reachable: true,
    verdict: `Reachable — Borzo replied: ${errors.join(", ") || `HTTP ${result.httpStatus}`}${authenticated ? "" : " (no token sent)"}`,
  };
}

async function probe(environment, cfg, { fetchImpl } = {}) {
  const authenticated = cfg.hasToken && cfg.environment === environment;
  const result = await borzoRequest({
    method: "POST",
    endpoint: "/calculate-order",
    body: checkPayload(cfg),
    token: authenticated ? cfg.token : undefined,
    environment,
    version: cfg.version,
    purpose: "connection-check",
    timeoutMs: 10000,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const o = (result.json && result.json.order) || {};
  return {
    environment,
    host: HOSTS[environment],
    authenticated,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    ok: result.ok,
    errors: (result.json && result.json.errors) || [],
    quoteRupees: result.ok ? Number(o.payment_amount ?? o.delivery_fee_amount) : null,
    ...verdictFor({ authenticated, result }),
  };
}

async function runConnectionCheck({ env = process.env, fetchImpl } = {}) {
  const cfg = resolveBorzoConfig(env);
  const startedAt = new Date().toISOString();
  const hosts = await Promise.all([probe("test", cfg, { fetchImpl }), probe("production", cfg, { fetchImpl })]);
  return { startedAt, configuredEnvironment: cfg.environment, hasToken: cfg.hasToken, hosts };
}

module.exports = { runConnectionCheck };
