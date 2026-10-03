/**
 * Borzo configuration, resolved from env vars in exactly one place so the
 * factory, the admin panel and the connection check can never disagree
 * about which Borzo environment is in use.
 *
 * Two hosts, one API (Borzo Business API, India):
 *   test        https://robotapitest-in.borzodelivery.com  — sandbox, never
 *               dispatches a courier, never charges anything. Self-serve
 *               token from https://apitest.borzodelivery.com/in/
 *   production  https://robot-in.borzodelivery.com  — real riders, real
 *               wallet charges.
 *
 * Production needs TWO independent switches (BORZO_ENV=production AND
 * BORZO_LIVE_CONFIRM=yes-dispatch-real-couriers). Flipping one by accident
 * leaves the site on the demo provider instead of booking real couriers.
 */

const HOSTS = {
  test: "https://robotapitest-in.borzodelivery.com",
  production: "https://robot-in.borzodelivery.com",
};

const LIVE_CONFIRM_PHRASE = "yes-dispatch-real-couriers";
const DEFAULT_VERSION = "1.8";

function baseUrlFor(environment, version = DEFAULT_VERSION) {
  return `${HOSTS[environment]}/api/business/${version}`;
}

function resolveBorzoConfig(env = process.env) {
  const enabled = String(env.BORZO_DELIVERY_ENABLED || "false").toLowerCase() === "true";
  // BORZO_AUTH_TOKEN is Borzo's own name for it; BORZO_API_KEY is what this
  // project's .env.example has always called it. Either works.
  const token = String(env.BORZO_AUTH_TOKEN || env.BORZO_API_KEY || "").trim();
  const requestedEnv = String(env.BORZO_ENV || "test").toLowerCase() === "production" ? "production" : "test";
  const liveConfirmed = env.BORZO_LIVE_CONFIRM === LIVE_CONFIRM_PHRASE;
  const version = String(env.BORZO_API_VERSION || DEFAULT_VERSION);
  const vehicleTypeId = Number.parseInt(env.BORZO_VEHICLE_TYPE_ID, 10) || 8; // 8 = motorbike in India

  const pickup = {
    name: String(env.PICKUP_NAME || "DE.25 by Harshali"),
    address: String(env.PICKUP_ADDRESS || "").trim(),
    phone: String(env.PICKUP_PHONE || "").trim(),
  };

  // Why Borzo is (or isn't) the active provider, in words the owner can act on.
  const problems = [];
  if (!enabled) problems.push("BORZO_DELIVERY_ENABLED is not true");
  if (!token) problems.push("No Borzo API token (BORZO_AUTH_TOKEN) is set");
  if (!pickup.address) problems.push("PICKUP_ADDRESS is empty — Borzo needs the kitchen's address");
  if (!pickup.phone) problems.push("PICKUP_PHONE is empty — Borzo needs a pickup contact number");
  if (requestedEnv === "production" && !liveConfirmed) {
    problems.push(`BORZO_ENV=production also needs BORZO_LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE}`);
  }

  return {
    enabled,
    token,
    hasToken: Boolean(token),
    environment: requestedEnv,
    liveConfirmed,
    version,
    vehicleTypeId,
    pickup,
    baseUrl: baseUrlFor(requestedEnv, version),
    problems,
    active: problems.length === 0,
  };
}

/** The same config with every secret removed — safe to send to the admin dashboard. */
function publicBorzoConfig(cfg = resolveBorzoConfig()) {
  return {
    enabled: cfg.enabled,
    active: cfg.active,
    hasToken: cfg.hasToken,
    environment: cfg.environment,
    liveConfirmed: cfg.liveConfirmed,
    version: cfg.version,
    baseUrl: cfg.baseUrl,
    pickupAddressSet: Boolean(cfg.pickup.address),
    pickupPhoneSet: Boolean(cfg.pickup.phone),
    problems: cfg.problems,
  };
}

module.exports = { HOSTS, LIVE_CONFIRM_PHRASE, DEFAULT_VERSION, baseUrlFor, resolveBorzoConfig, publicBorzoConfig };
