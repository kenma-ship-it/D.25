import { escapeHtml, formatCurrency, qs, qsa, announce } from "../js/utils.js";

const TOKEN_KEY = "de25_admin_token";
const SUPABASE_SESSION_KEY = "de25_admin_supabase_session";
const SOUND_KEY = "de25_admin_sound";
const POLL_MS = 5000;

const STATUS_LABELS = {
  ORDER_PLACED: "Order Placed",
  PAYMENT_CONFIRMED: "Payment Confirmed",
  PREPARING: "Preparing",
  READY_FOR_DELIVERY: "Ready for Delivery",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
};
const STATUS_ORDER = Object.keys(STATUS_LABELS);

let seenOrderIds = null; // null = "haven't loaded once yet" (don't alert on first load)
let pollTimer = null;
let soundOn = localStorage.getItem(SOUND_KEY) !== "off";

// Which admin-auth mode the server is configured for ("token" | "supabase"),
// learned once at boot from GET /api/admin/auth-config (see
// server/lib/adminAuthConfig.js) — decides which login form is shown and
// how adminFetch() authenticates every request.
let authMode = null;
let supabaseConfig = null; // { url, anonKey } — only set when authMode === "supabase"

// ---------------------------------------------------------------------
// Credential storage (token mode)
// ---------------------------------------------------------------------
function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch (_e) {
    return "";
  }
}
function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (_e) {
    /* private browsing / storage disabled — dashboard still works for this tab, just re-asks next visit */
  }
}
function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_e) {}
}

// ---------------------------------------------------------------------
// Credential storage (Supabase mode) — access_token, refresh_token, and
// when the access token expires (epoch seconds), so adminFetch() knows to
// refresh proactively instead of always waiting for a 401 first.
// ---------------------------------------------------------------------
function getSupabaseSession() {
  try {
    const raw = localStorage.getItem(SUPABASE_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_e) {
    return null;
  }
}
function setSupabaseSession(session) {
  try {
    localStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify(session));
  } catch (_e) {}
}
function clearSupabaseSession() {
  try {
    localStorage.removeItem(SUPABASE_SESSION_KEY);
  } catch (_e) {}
}

/** POSTs to Supabase's GoTrue token endpoint — the only Supabase Auth call this page needs a grant_type for. */
async function supabaseAuthRequest(grantType, body) {
  const res = await fetch(`${supabaseConfig.url.replace(/\/$/, "")}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: {
      apikey: supabaseConfig.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error_description || data.msg || data.error || "Sign-in failed.";
    throw new Error(message);
  }
  return data;
}

function sessionFromAuthResponse(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
}

/** Refreshes the Supabase session using the stored refresh token. Returns the new session, or null on failure. */
async function refreshSupabaseSession() {
  const current = getSupabaseSession();
  if (!current || !current.refreshToken) return null;
  try {
    const data = await supabaseAuthRequest("refresh_token", { refresh_token: current.refreshToken });
    const session = sessionFromAuthResponse(data);
    setSupabaseSession(session);
    return session;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Authenticated fetch — attaches the right credential for whichever mode
// is active, and (Supabase mode only) transparently refreshes an expired
// access token once before giving up. Callers keep checking
// res.status === 401 exactly as before either way.
// ---------------------------------------------------------------------
async function adminFetch(path, options = {}) {
  const doFetch = (bearer) =>
    fetch(path, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${bearer}` },
    });

  if (authMode === "supabase") {
    let session = getSupabaseSession();
    if (session && session.expiresAt - 30 < Math.floor(Date.now() / 1000)) {
      // Proactively refresh a token that's already expired or about to.
      session = (await refreshSupabaseSession()) || session;
    }
    let res = await doFetch(session ? session.accessToken : "");
    if (res.status === 401) {
      const refreshed = await refreshSupabaseSession();
      if (refreshed) res = await doFetch(refreshed.accessToken);
    }
    return res;
  }

  return doFetch(getToken());
}

/** A short two-tone beep via Web Audio — no external asset, so it can never fail to load. */
function playChime() {
  if (!soundOn) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.001, ctx.currentTime + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.16 + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.16);
      osc.stop(ctx.currentTime + i * 0.16 + 0.3);
    });
  } catch (_e) {
    /* Web Audio unavailable — the visual banner + list highlight still work without sound. */
  }
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}

function deliveryNote(order) {
  const isLive = Boolean(order.deliveryQuote && order.deliveryQuote.isLive);
  return isLive
    ? "Live Borzo delivery"
    : "Demo delivery estimate — DE.25 is handling delivery directly for now.";
}

function orderCardMarkup(order, isNew) {
  const addr = order.address;
  const addressLine = [addr.house, addr.street, addr.area, addr.city, addr.pincode].filter(Boolean).join(", ");
  const currentIndex = STATUS_ORDER.indexOf(order.status);
  const isFinal = currentIndex === STATUS_ORDER.length - 1;
  const lines = order.lines
    .map(
      (l) =>
        `<div><span>${l.qty} &times; ${escapeHtml(l.name)}${l.variantLabel ? ` (${escapeHtml(l.variantLabel)})` : ""}</span><span>${formatCurrency(l.lineTotal)}</span></div>`
    )
    .join("");

  return `
    <article class="order-card${isNew ? " is-new" : ""}" data-order-id="${escapeHtml(order.orderId)}">
      <div class="order-card-top">
        <div>
          <div class="order-token">${escapeHtml(order.token)}</div>
          <span class="status-pill st-${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span>
        </div>
        <div style="text-align:right;">
          <div class="order-total">${formatCurrency(order.total)}</div>
          <div class="order-time">${timeAgo(order.createdAt)}</div>
        </div>
      </div>
      <div class="order-customer">
        <strong>${escapeHtml(order.customer.name)} &middot; <a href="tel:${escapeHtml(order.customer.phone)}">${escapeHtml(order.customer.phone)}</a></strong>
        <div class="order-address">${escapeHtml(addressLine)}${addr.landmark ? ` (near ${escapeHtml(addr.landmark)})` : ""}</div>
      </div>
      <div class="order-lines">${lines}</div>
      <div class="order-foot">
        <span class="payment-tag">${order.paymentMethod === "upi" ? "Online · UPI" : "Online payment"}</span>
        <button type="button" class="advance-btn" data-advance ${isFinal ? "disabled" : ""}>
          ${isFinal ? "Delivered" : `Mark as ${escapeHtml(STATUS_LABELS[STATUS_ORDER[currentIndex + 1]] || "next step")}`}
        </button>
      </div>
      <p class="delivery-note">${escapeHtml(deliveryNote(order))}</p>
    </article>
  `;
}

function renderOrders(orders) {
  const list = qs("#orders-list");
  qs("#order-count").textContent = String(orders.length);

  // seenOrderIds must be initialized on every first call regardless of
  // whether there happen to be zero orders yet — otherwise a store with no
  // orders at unlock time would never leave "first load" state, and the
  // very first real order would be silently treated as already-seen.
  const isFirstLoad = seenOrderIds === null;
  if (isFirstLoad) seenOrderIds = new Set();

  if (orders.length === 0) {
    list.innerHTML = `<p class="empty-note">No orders yet.</p>`;
    return;
  }

  const newOnes = orders.filter((o) => !seenOrderIds.has(o.orderId));
  orders.forEach((o) => seenOrderIds.add(o.orderId));

  list.innerHTML = orders.map((o) => orderCardMarkup(o, !isFirstLoad && newOnes.some((n) => n.orderId === o.orderId))).join("");

  qsa("[data-advance]", list).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".order-card");
      const orderId = card.dataset.orderId;
      btn.disabled = true;
      try {
        const res = await adminFetch(`/api/admin/orders/${orderId}/advance`, { method: "PUT" });
        if (res.ok) {
          fetchOrders();
        } else {
          btn.disabled = false;
        }
      } catch (_e) {
        btn.disabled = false;
      }
    });
  });

  if (!isFirstLoad && newOnes.length > 0) {
    playChime();
    const banner = qs("#new-order-banner");
    const summary =
      newOnes.length === 1
        ? `New order: ${newOnes[0].token} — ${newOnes[0].customer.name} — ${formatCurrency(newOnes[0].total)}`
        : `${newOnes.length} new orders just came in!`;
    banner.textContent = summary;
    banner.hidden = false;
    announce(summary);
    setTimeout(() => {
      banner.hidden = true;
    }, 8000);
  }
}

function renderNotifications(activeProvider, entries) {
  const modeEl = qs("#notification-mode");
  if (activeProvider === "demo") {
    modeEl.innerHTML = `<span class="mode-demo">Demo mode</span> — WhatsApp isn't connected yet`;
  } else {
    modeEl.innerHTML = `<span class="mode-live">Live</span> — sending via ${escapeHtml(activeProvider)}`;
  }

  const list = qs("#notifications-list");
  if (!entries || entries.length === 0) {
    list.innerHTML = `<p class="empty-note">No notifications yet.</p>`;
    return;
  }
  list.innerHTML = entries
    .slice(0, 30)
    .map(
      (n) => `
      <div class="notification-card">
        <div class="notification-type">${escapeHtml((n.type || "").replace(/_/g, " "))}</div>
        <div class="notification-to">to ${escapeHtml(n.to || "—")} &middot; ${timeAgo(n.sentAt)}</div>
        <div class="notification-text">${escapeHtml(n.message || "")}</div>
      </div>`
    )
    .join("");
}

async function fetchOrders() {
  try {
    const res = await adminFetch("/api/admin/orders?limit=100");
    if (res.status === 401) return handleAuthFailure();
    if (res.status === 404) return handleDisabled();
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    qs("#connection-status").textContent = "Live";
    renderOrders(data.orders);
  } catch (_e) {
    qs("#connection-status").textContent = "Reconnecting…";
  }
}

async function fetchNotifications() {
  try {
    const res = await adminFetch("/api/admin/notifications");
    if (!res.ok) return;
    const data = await res.json();
    renderNotifications(data.activeProvider, data.entries);
  } catch (_e) {
    /* non-critical — orders panel is the important one */
  }
}

function poll() {
  fetchOrders();
  fetchNotifications();
}

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Shows whichever login form matches the active auth mode, hides the other. */
function showLogin(message) {
  stopPolling();
  qs("#dashboard").hidden = true;
  qs("#login-screen").hidden = false;

  const isSupabase = authMode === "supabase";
  qs("#login-form").hidden = isSupabase;
  qs("#supabase-login-form").hidden = !isSupabase;

  if (isSupabase) {
    const err = qs("#supabase-login-error");
    err.textContent = message || "";
    err.hidden = !message;
    qs("#email-input").focus();
  } else {
    const err = qs("#login-error");
    err.textContent = message || "";
    err.hidden = !message;
    qs("#token-input").focus();
  }
}

function showDashboard() {
  qs("#login-screen").hidden = true;
  qs("#dashboard").hidden = false;
  seenOrderIds = null;
  startPolling();
}

function handleAuthFailure() {
  if (authMode === "supabase") {
    clearSupabaseSession();
    showLogin("Your session expired or is invalid. Please sign in again.");
  } else {
    clearToken();
    showLogin("That token isn't valid. Check .env's ADMIN_TOKEN and try again.");
  }
}

function handleDisabled() {
  stopPolling();
  qs("#login-screen").hidden = true;
  qs("#dashboard").hidden = true;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="dash-error">Admin access isn't enabled on this server yet. Set ADMIN_TOKEN (or configure Supabase Auth) in .env and restart the server to turn it on.</div>`
  );
}

/** Token-mode sign-in: store the token, probe a real endpoint to confirm it's valid. */
async function tryUnlockWithToken(token) {
  setToken(token);
  const res = await fetch("/api/admin/orders?limit=1", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res) {
    showLogin("Couldn't reach the server. Check that it's running and try again.");
    return;
  }
  if (res.status === 401) return handleAuthFailure();
  if (res.status === 404) return handleDisabled();
  if (!res.ok) {
    showLogin("Something went wrong. Please try again.");
    return;
  }
  showDashboard();
}

/** Supabase-mode sign-in: real email/password auth against Supabase's own Auth API. */
async function signInWithSupabase(email, password) {
  try {
    const data = await supabaseAuthRequest("password", { email, password });
    setSupabaseSession(sessionFromAuthResponse(data));
    showDashboard();
  } catch (err) {
    showLogin(err.message || "Sign-in failed. Check your email and password and try again.");
  }
}

/** Tries to resume a stored Supabase session without asking the owner to sign in again. */
async function tryResumeSupabaseSession() {
  const session = getSupabaseSession();
  if (!session) {
    showLogin();
    return;
  }
  const res = await adminFetch("/api/admin/orders?limit=1").catch(() => null);
  if (!res) {
    showLogin("Couldn't reach the server. Check that it's running and try again.");
    return;
  }
  if (res.status === 401) return handleAuthFailure();
  if (res.status === 404) return handleDisabled();
  if (!res.ok) {
    showLogin("Something went wrong. Please try again.");
    return;
  }
  showDashboard();
}

async function doLock() {
  stopPolling();
  if (authMode === "supabase") {
    const session = getSupabaseSession();
    if (session) {
      // Best-effort — an unreachable/expired sign-out call should never
      // block the owner from locking the dashboard on this device.
      fetch(`${supabaseConfig.url.replace(/\/$/, "")}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: supabaseConfig.anonKey, Authorization: `Bearer ${session.accessToken}` },
      }).catch(() => {});
    }
    clearSupabaseSession();
  } else {
    clearToken();
  }
  showLogin();
}

qs("#login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const token = qs("#token-input").value.trim();
  if (!token) return;
  tryUnlockWithToken(token);
});

qs("#supabase-login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = qs("#email-input").value.trim();
  const password = qs("#password-input").value;
  if (!email || !password) return;
  signInWithSupabase(email, password);
});

qs("#lock-btn").addEventListener("click", doLock);

function syncSoundButton() {
  const btn = qs("#sound-toggle");
  btn.setAttribute("aria-pressed", String(soundOn));
  btn.textContent = soundOn ? "Sound: On" : "Sound: Off";
}
syncSoundButton();

qs("#sound-toggle").addEventListener("click", () => {
  soundOn = !soundOn;
  try {
    localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  } catch (_e) {}
  syncSoundButton();
});

// Boot: ask the server which auth mode is active before showing any login
// form, so a Supabase-configured deployment doesn't flash a token field
// (or vice versa). See server/lib/adminAuthConfig.js.
(async function boot() {
  const res = await fetch("/api/admin/auth-config").catch(() => null);
  if (!res || res.status === 404) return handleDisabled();

  const config = await res.json().catch(() => null);
  if (!config || !config.provider) return handleDisabled();

  authMode = config.provider;
  if (authMode === "supabase") {
    supabaseConfig = { url: config.supabaseUrl, anonKey: config.supabaseAnonKey };
    await tryResumeSupabaseSession();
  } else {
    const stored = getToken();
    if (stored) {
      await tryUnlockWithToken(stored);
    } else {
      showLogin();
    }
  }
})();
