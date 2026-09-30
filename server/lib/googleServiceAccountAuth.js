/**
 * Minimal Google service-account OAuth2 helper.
 *
 * This exists so server/products/GoogleSheetsProductsProvider.js can call
 * the Sheets API without pulling in the full `googleapis` SDK (multiple MB,
 * dozens of transitive deps) for what is, underneath, one OAuth2 grant type:
 * a signed JWT assertion exchanged for a short-lived access token. That's a
 * handful of lines with `jsonwebtoken` (already a dependency for verifying
 * Supabase tokens) plus the built-in fetch — consistent with this project's
 * existing preference for small, auditable dependencies over large SDKs.
 *
 * Flow (RFC 7523 JWT Bearer grant, as documented by Google):
 *   1. Build a JWT claiming the service account as issuer, scoped to the
 *      Sheets API, signed with the service account's RSA private key.
 *   2. POST it to Google's token endpoint.
 *   3. Cache the returned access token until shortly before it expires.
 *
 * Requires a Google Cloud service account with the Sheets API enabled and
 * the target spreadsheet explicitly shared with that service account's
 * email (Sheets does not grant access just because you own the project —
 * share the sheet with GOOGLE_SERVICE_ACCOUNT_EMAIL like you would with any
 * other collaborator, as either Viewer for read-only or Editor if the admin
 * dashboard should be able to write price/availability changes back).
 */
const jwt = require("jsonwebtoken");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let cachedToken = null; // { accessToken, expiresAt }

/**
 * Google service-account JSON keys store the private key with literal
 * "\n" sequences when the whole key is pasted into a single-line env var.
 * This restores real newlines so jsonwebtoken's RS256 signer can parse it.
 */
function normalizePrivateKey(key) {
  return String(key || "").replace(/\\n/g, "\n");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.accessToken;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  if (!email || !privateKey) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not set."
    );
  }

  const assertion = jwt.sign(
    {
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
    },
    privateKey,
    {
      algorithm: "RS256",
      issuer: email,
      subject: undefined,
      expiresIn: "1h",
    }
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 3600),
  };
  return cachedToken.accessToken;
}

/** Test-only: forget the cached token so the next call re-authenticates. */
function _resetTokenCache() {
  cachedToken = null;
}

module.exports = { getAccessToken, _resetTokenCache };
