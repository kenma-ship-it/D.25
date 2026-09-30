/**
 * Minimal Supabase REST helper — no @supabase/supabase-js dependency, same
 * "small hand-rolled client over a plain REST API" choice already made for
 * Google Sheets (see server/lib/googleServiceAccountAuth.js). Supabase's
 * data API (PostgREST) and Auth API (GoTrue) are both plain HTTP/JSON, so
 * a thin fetch wrapper covers everything this project needs.
 *
 * SUPABASE_SERVICE_ROLE_KEY is a secret that bypasses Row Level Security
 * entirely — it must only ever be used server-side (as it is here) and
 * must never be sent to the browser. The browser-facing anon key
 * (SUPABASE_ANON_KEY) is safe to expose and is what public/admin/admin.js
 * uses for the login form itself — see server/middleware/adminAuth.js.
 */

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Calls PostgREST at {SUPABASE_URL}/rest/v1/{table}. `query` is an object
 * of raw PostgREST query params (e.g. { order: "created_at.desc", limit: "50" }).
 * `prefer` sets the Prefer header (e.g. "return=representation" to get the
 * row back on insert/update).
 */
async function restRequest(table, { method = "GET", query = {}, body, prefer } = {}) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.");
  }

  const qs = new URLSearchParams(query).toString();
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/${table}${qs ? `?${qs}` : ""}`;

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(endpoint, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase REST ${method} ${table} failed (${res.status}): ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

module.exports = { restRequest, supabaseConfigured };
