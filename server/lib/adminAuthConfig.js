/**
 * Decides which admin-authentication mode is active, in one place, so
 * server/middleware/adminAuth.js (which enforces it) and
 * server/routes/admin.js's /auth-config route (which tells the dashboard
 * which login form to render) can never disagree with each other.
 *
 * Modes:
 *   "none"     — no admin auth configured at all. Every /api/admin/* route
 *                (including /auth-config itself) 404s, so an unconfigured
 *                deployment doesn't advertise that an admin surface exists
 *                — same invariant the original bearer-token-only design had.
 *   "token"    — the original design: a single ADMIN_TOKEN bearer secret.
 *                Active whenever ADMIN_TOKEN is set and Supabase auth isn't
 *                explicitly requested (or was requested but isn't fully
 *                configured, in which case this falls back to token mode
 *                with a loud warning rather than silently locking everyone
 *                out).
 *   "supabase" — real user accounts via Supabase Auth. Active only when
 *                ADMIN_AUTH_PROVIDER=supabase AND SUPABASE_URL,
 *                SUPABASE_ANON_KEY and SUPABASE_JWT_SECRET are all set.
 *
 * Restart the server to pick up a changed ADMIN_AUTH_PROVIDER — same
 * "restart to retry" contract as every other provider factory here.
 */
function getAdminAuthMode() {
  const wantsSupabase = String(process.env.ADMIN_AUTH_PROVIDER || "").toLowerCase() === "supabase";
  const hasSupabaseConfig = Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_JWT_SECRET
  );
  const hasToken = Boolean(process.env.ADMIN_TOKEN);

  if (wantsSupabase && hasSupabaseConfig) {
    return { mode: "supabase", supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY };
  }

  if (wantsSupabase && !hasSupabaseConfig) {
    // eslint-disable-next-line no-console
    console.warn(
      "[admin] ADMIN_AUTH_PROVIDER=supabase but SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_JWT_SECRET " +
        "are not all set — " + (hasToken ? "falling back to ADMIN_TOKEN auth." : "admin API stays disabled.")
    );
  }

  if (hasToken) return { mode: "token" };

  return { mode: "none" };
}

module.exports = { getAdminAuthMode };
