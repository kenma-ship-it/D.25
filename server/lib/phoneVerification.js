/**
 * WhatsApp phone verification — one-time codes and the short-lived
 * "this phone is verified" token they unlock.
 *
 * Why this exists: before it, anyone who typed someone else's phone number
 * into "My Orders" saw that person's orders, and checkout would send a
 * DE.25-branded WhatsApp receipt to whatever number was typed in. Both now
 * require proof that the person at the keyboard can read WhatsApp messages
 * sent to that number.
 *
 * Flow:
 *   1. issueCode(phone)            -> 6-digit code, sent over WhatsApp
 *   2. confirmCode(phone, code)    -> signed token, valid TOKEN_TTL_MS
 *   3. verifyToken(token, phone)   -> true only for that exact phone
 *
 * Codes are stored hashed (HMAC), expire after CODE_TTL_MS, allow
 * MAX_ATTEMPTS guesses, and can't be re-sent faster than RESEND_COOLDOWN_MS.
 * Tokens are stateless HMAC-signed strings, so they survive across requests
 * without a session store.
 *
 * Storage note: pending codes live in this process's memory. That's right
 * for a single server (this app's deployment model). If DE.25 ever runs
 * several server instances behind a load balancer, move `pending` to a
 * shared store (Redis / the Supabase DB) — a code issued by one instance
 * would otherwise be unknown to the next.
 */
const crypto = require("crypto");

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const TOKEN_VERSION = "pv1";

let generatedSecret = null;
function getSecret() {
  if (process.env.PHONE_VERIFICATION_SECRET) return process.env.PHONE_VERIFICATION_SECRET;
  if (!generatedSecret) {
    // No configured secret: a random per-process one still keeps tokens
    // unforgeable; it only means tokens stop working after a restart.
    generatedSecret = crypto.randomBytes(32).toString("hex");
    if (process.env.NODE_ENV === "production") {
      // eslint-disable-next-line no-console
      console.warn("[verify] PHONE_VERIFICATION_SECRET is not set — using a random secret; customers must re-verify after every restart.");
    }
  }
  return generatedSecret;
}

const hmac = (value) => crypto.createHmac("sha256", getSecret()).update(value).digest("hex");

function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), "utf8");
  const bufB = Buffer.from(String(b), "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** phone -> { codeHash, expiresAt, attemptsLeft, sentAt } */
const pending = new Map();

function sweep(now) {
  for (const [phone, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(phone);
  }
}

class VerificationError extends Error {
  constructor(message, statusCode, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

/**
 * Creates (or replaces) the pending code for `phone`.
 * @returns {{ code: string, expiresInSeconds: number, resendInSeconds: number }}
 * @throws VerificationError(429) if a code was sent less than RESEND_COOLDOWN_MS ago.
 */
function issueCode(phone, now = Date.now()) {
  sweep(now);
  const existing = pending.get(phone);
  if (existing && now - existing.sentAt < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.sentAt)) / 1000);
    throw new VerificationError(`Please wait ${wait}s before asking for another code.`, 429, { retryAfterSeconds: wait });
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  pending.set(phone, {
    codeHash: hmac(`code:${phone}:${code}`),
    expiresAt: now + CODE_TTL_MS,
    attemptsLeft: MAX_ATTEMPTS,
    sentAt: now,
  });
  return { code, expiresInSeconds: CODE_TTL_MS / 1000, resendInSeconds: RESEND_COOLDOWN_MS / 1000 };
}

/** Drops a pending code — used when sending it over WhatsApp failed, so the customer can retry immediately. */
function cancelCode(phone) {
  pending.delete(phone);
}

/**
 * Checks `code` for `phone`. On success the code is consumed and a
 * verification token is returned.
 * @throws VerificationError(400) wrong code (with attemptsLeft), (410) expired / none, (429) out of attempts.
 */
function confirmCode(phone, code, now = Date.now()) {
  const entry = pending.get(phone);
  if (!entry || entry.expiresAt <= now) {
    pending.delete(phone);
    throw new VerificationError("That code has expired. Please ask for a new one.", 410);
  }
  const ok = /^\d{6}$/.test(String(code || "")) && safeEqualHex(entry.codeHash, hmac(`code:${phone}:${code}`));
  if (!ok) {
    entry.attemptsLeft -= 1;
    if (entry.attemptsLeft <= 0) {
      pending.delete(phone);
      throw new VerificationError("Too many wrong tries. Please ask for a new code.", 429);
    }
    throw new VerificationError(
      `That code isn't right. ${entry.attemptsLeft} ${entry.attemptsLeft === 1 ? "try" : "tries"} left.`,
      400,
      { attemptsLeft: entry.attemptsLeft }
    );
  }
  pending.delete(phone);
  return { token: signToken(phone, now + TOKEN_TTL_MS), expiresInSeconds: TOKEN_TTL_MS / 1000 };
}

function signToken(phone, expiresAt) {
  const body = `${TOKEN_VERSION}.${phone}.${expiresAt}`;
  return `${body}.${hmac(`token:${body}`)}`;
}

/** True only if `token` is an unexpired, untampered token issued for exactly `phone`. */
function verifyToken(token, phone, now = Date.now()) {
  if (typeof token !== "string" || typeof phone !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return false;
  const [version, tokenPhone, expiresAtRaw, sig] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (tokenPhone !== phone) return false;
  return safeEqualHex(sig, hmac(`token:${version}.${tokenPhone}.${expiresAtRaw}`));
}

/** Test hook. */
function _reset() {
  pending.clear();
  generatedSecret = null;
}

module.exports = {
  issueCode,
  cancelCode,
  confirmCode,
  verifyToken,
  VerificationError,
  CODE_TTL_MS,
  TOKEN_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_ATTEMPTS,
  _reset,
};
