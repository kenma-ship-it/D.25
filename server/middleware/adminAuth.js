/**
 * Admin authorization.
 *
 * Supports two modes (see server/lib/adminAuthConfig.js for how the active
 * one is chosen):
 *
 *   "token"    — the original design: a single bearer secret from an
 *                environment variable. Deliberately minimal — no users,
 *                roles, or password reset — because building a full
 *                identity system was out of scope for the initial demo.
 *   "supabase" — real user accounts via Supabase Auth. Recommended once
 *                more than one person needs their own login, or you want
 *                password reset / session expiry without hand-rolling it.
 *
 * Both modes share the same two hard guarantees the original design had:
 * the admin API is authorization-checked on the server for every request
 * (never "hidden" by just not linking to it in the UI), and it is a hard
 * 404 — not a 401/403 — when NEITHER mode is configured, so an
 * unconfigured deployment doesn't advertise that an admin surface exists.
 */
const crypto = require("crypto");
const { getAdminAuthMode } = require("../lib/adminAuthConfig");
const { verifySupabaseAccessToken } = require("../lib/supabaseAuth");

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

function adminAuth(req, res, next) {
  const { mode } = getAdminAuthMode();

  if (mode === "none") {
    return res.status(404).json({ error: "Not found." });
  }

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized." });

  if (mode === "token") {
    if (!safeEqual(token, process.env.ADMIN_TOKEN)) {
      return res.status(401).json({ error: "Unauthorized." });
    }
    return next();
  }

  // mode === "supabase"
  let payload;
  try {
    payload = verifySupabaseAccessToken(token);
  } catch (_err) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  // A valid Supabase login only proves "this person has an account in the
  // project" — and new Supabase projects allow public sign-up by default, so
  // on its own that would make any stranger who signs up a shop admin.
  // Admin access additionally requires the account's email to be on the
  // ADMIN_EMAILS allowlist. Fails closed: an empty/unset list admits nobody.
  if (!isAllowedAdminEmail(payload.email)) {
    return res.status(403).json({ error: "This account is not allowed to access the dashboard." });
  }
  req.adminUser = payload;
  return next();
}

function getAdminEmailAllowlist() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedAdminEmail(email) {
  if (typeof email !== "string" || !email) return false;
  return getAdminEmailAllowlist().includes(email.trim().toLowerCase());
}

module.exports = { adminAuth, isAllowedAdminEmail };
