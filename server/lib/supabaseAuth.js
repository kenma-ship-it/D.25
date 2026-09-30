/**
 * Verifies a Supabase Auth access token server-side, without the
 * @supabase/supabase-js SDK (see server/lib/supabaseRest.js for why this
 * project prefers small hand-rolled clients over SDKs here).
 *
 * Supabase's default Auth setup signs access tokens as HS256 JWTs using
 * the project's JWT secret (Project Settings -> API -> JWT Settings).
 * Verifying locally with that shared secret is the standard fast path —
 * no network call needed per request, which matters here since the owner
 * dashboard polls every 5 seconds. (Newer Supabase projects can opt into
 * asymmetric JWT signing with rotating keys instead; if DE.25's project
 * uses that, this function would need to fetch and cache the project's
 * JWKS instead of using a fixed shared secret — out of scope for this
 * build, called out here so it isn't silently wrong if that's the setup.)
 */
const jwt = require("jsonwebtoken");

/**
 * @returns {object} the decoded JWT payload (sub, email, etc.) on success.
 * @throws if the token is missing, malformed, expired, or fails signature
 *   verification — callers should treat any throw as "unauthenticated".
 */
function verifySupabaseAccessToken(token) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set.");
  const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
  // Supabase issues "authenticated" as the audience for logged-in users —
  // rejecting anything else stops a token meant for another purpose
  // (e.g. a service-role-minted token) from being accepted here.
  if (payload.aud !== "authenticated") {
    throw new Error("Token is not a Supabase user access token (unexpected audience).");
  }
  return payload;
}

module.exports = { verifySupabaseAccessToken };
