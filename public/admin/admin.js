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
const PRE_PAYMENT_LABELS = { AWAITING_PAYMENT: "Awaiting payment", CANCELLED: "Cancelled — not paid" };

// order.payment.status -> [label, css tone] (see server/payments/service.js)
const PAYMENT_LABELS = {
  PENDING: ["Awaiting payment", "wait"],
  FAILED: ["Payment failed", "bad"],
  AUTHORIZED: ["Authorised — not captured", "bad"],
  PAID: ["Paid", "ok"],
  EXPIRED: ["Not paid — cancelled", "off"],
  PARTIALLY_REFUNDED: ["Partly refunded", "wait"],
  REFUNDED: ["Refunded", "off"],
};
const ISSUE_TITLES = {
  PAID_AFTER_EXPIRY: "Paid after the order expired",
  DUPLICATE_PAYMENT: "Charged twice",
  AMOUNT_MISMATCH: "Amount doesn't match",
  AUTHORIZED_NOT_CAPTURED: "Payment not captured",
  REFUND_FAILED: "Refund failed",
  GATEWAY_ORDER_MISMATCH: "Payment under another gateway order",
};
const ATTEMPT_LABELS = { paid: "Paid", failed: "Failed", authorized: "Authorised", pending: "Pending", refunded: "Refunded" };
const SOURCE_LABELS = { checkout: "customer's checkout", webhook: "gateway webhook", reconcile: "auto check", "owner-check": "your check", "expiry-check": "expiry check", client: "customer's browser" };

let orderFilter = "all";
let lastOrders = [];
let paymentsInfo = { provider: "demo", isLive: false };

let seenOrderIds = null; // null = "haven't loaded once yet" (don't alert on first load) — holds ids of orders seen as PAID
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

const rupees = (paise) => formatCurrency((Number(paise) || 0) / 100);
const isPaid = (order) => !order.payment || ["PAID", "PARTIALLY_REFUNDED"].includes(order.payment.status);
const openIssues = (order) => ((order.payment && order.payment.issues) || []).filter((i) => !i.resolved);

function when(iso) {
  return iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
}

function paymentBlockMarkup(order) {
  const p = order.payment;
  if (!p) return `<div class="pay-block"><span class="pay-badge tone-off">Placed before online payments</span></div>`;
  const [label, tone] = PAYMENT_LABELS[p.status] || [p.status, "wait"];
  const methodBits = [p.method && p.method.toUpperCase(), p.vpa, p.bank, p.wallet].filter(Boolean).join(" · ");
  const rows = [
    ["Amount", `${rupees(p.amountPaise)}${p.amountPaidPaise && p.amountPaidPaise !== p.amountPaise ? ` (paid ${rupees(p.amountPaidPaise)})` : ""}`],
    p.paymentId ? ["Payment ID", `<code>${escapeHtml(p.paymentId)}</code>`] : null,
    methodBits ? ["Method", escapeHtml(methodBits)] : null,
    p.paidAt ? ["Paid at", escapeHtml(when(p.paidAt))] : null,
    !p.paidAt && order.status === "AWAITING_PAYMENT" ? ["Pay by", escapeHtml(when(p.expiresAt))] : null,
    ["Gateway order", `<code>${escapeHtml(p.gatewayOrderId || "—")}</code>${p.provider === "demo" ? ' <span class="pay-demo">demo</span>' : ""}`],
    p.lastCheckedAt ? ["Last checked", escapeHtml(timeAgo(p.lastCheckedAt))] : null,
  ].filter(Boolean);

  const issues = openIssues(order)
    .map(
      (i) => `<div class="pay-issue">
        <strong>${escapeHtml(ISSUE_TITLES[i.code] || i.code)}</strong>${i.paymentId ? ` <code>${escapeHtml(i.paymentId)}</code>` : ""}${i.amountPaise ? ` · ${rupees(i.amountPaise)}` : ""}
        <p>${escapeHtml(i.message)}</p>
        <button type="button" class="pay-link" data-resolve="${escapeHtml(i.code)}" data-payment="${escapeHtml(i.paymentId || "")}">Mark as handled</button>
      </div>`
    )
    .join("");

  const refunds = (p.refunds || [])
    .map((r) => `<li>Refund ${rupees(r.amountPaise)} · ${escapeHtml(r.status)} · <code>${escapeHtml(r.refundId)}</code> · ${escapeHtml(when(r.at))}</li>`)
    .join("");
  const attempts = (p.attempts || [])
    .slice()
    .reverse()
    .map(
      (a) => `<li class="att-${escapeHtml(a.status)}">
        <span class="att-status">${escapeHtml(ATTEMPT_LABELS[a.status] || a.status)}</span>
        ${rupees(a.amountPaise)}${a.method ? ` · ${escapeHtml(a.method.toUpperCase())}` : ""} · ${escapeHtml(when(a.at))}
        ${a.errorReason ? `<div class="att-reason">${escapeHtml(a.errorReason)}${a.errorCode ? ` (${escapeHtml(a.errorCode)})` : ""}</div>` : ""}
        <div class="att-ref"><code>${escapeHtml(a.paymentId)}</code> · via ${escapeHtml(SOURCE_LABELS[a.source] || a.source)}</div>
      </li>`
    )
    .join("");
  const nAttempts = (p.attempts || []).length;
  const canCheck = paymentsInfo.isLive && p.provider === paymentsInfo.provider;

  return `<div class="pay-block tone-${tone}">
      <div class="pay-head">
        <span class="pay-badge tone-${tone}">${escapeHtml(label)}</span>
        ${canCheck ? `<button type="button" class="pay-link" data-reconcile>Check payment</button>` : ""}
      </div>
      <dl class="pay-meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${issues}
      ${
        nAttempts || refunds
          ? `<details class="pay-attempts"><summary>${nAttempts} payment attempt${nAttempts === 1 ? "" : "s"}${refunds ? " · refunds" : ""}</summary><ol>${attempts}${refunds}</ol></details>`
          : `<p class="pay-none">No payment attempt yet.</p>`
      }
    </div>`;
}

function orderCardMarkup(order, isNew) {
  const addr = order.address;
  const addressLine = [addr.house, addr.street, addr.area, addr.city, addr.pincode].filter(Boolean).join(", ");
  const currentIndex = STATUS_ORDER.indexOf(order.status);
  const isFinal = currentIndex === STATUS_ORDER.length - 1;
  const paid = isPaid(order);
  const advanceLabel = !paid
    ? order.status === "CANCELLED"
      ? "Cancelled"
      : "Waiting for payment"
    : isFinal
      ? "Delivered"
      : `Mark as ${escapeHtml(STATUS_LABELS[STATUS_ORDER[currentIndex + 1]] || "next step")}`;
  const statusText = STATUS_LABELS[order.status] || PRE_PAYMENT_LABELS[order.status] || order.status;
  const needsAttention = openIssues(order).length > 0;
  const lines = order.lines
    .map(
      (l) =>
        `<div><span>${l.qty} &times; ${escapeHtml(l.name)}${l.variantLabel ? ` (${escapeHtml(l.variantLabel)})` : ""}</span><span>${formatCurrency(l.lineTotal)}</span></div>`
    )
    .join("");

  return `
    <article class="order-card${isNew ? " is-new" : ""}${needsAttention ? " needs-attention" : ""}${paid ? "" : " is-unpaid"}" data-order-id="${escapeHtml(order.orderId)}">
      <div class="order-card-top">
        <div>
          <div class="order-token">${escapeHtml(order.token)} <span class="order-token-name">&middot; ${escapeHtml(order.customer.name)}</span></div>
          <span class="status-pill st-${escapeHtml(order.status)}">${escapeHtml(statusText)}</span>
        </div>
        <div style="text-align:right;">
          <div class="order-total">${formatCurrency(order.total)}</div>
          <div class="order-time">${timeAgo(order.createdAt)}</div>
        </div>
      </div>
      <div class="order-customer">
        <strong><a href="tel:${escapeHtml(order.customer.phone)}">${escapeHtml(order.customer.phone)}</a></strong>
        <div class="order-address">${escapeHtml(addressLine)}${addr.landmark ? ` (near ${escapeHtml(addr.landmark)})` : ""}</div>
      </div>
      <div class="order-lines">${lines}</div>
      ${paymentBlockMarkup(order)}
      <div class="order-foot">
        <span class="payment-tag">Online payment only</span>
        <button type="button" class="advance-btn" data-advance ${isFinal || !paid ? "disabled" : ""}>${advanceLabel}</button>
      </div>
      <p class="delivery-note">${escapeHtml(deliveryNote(order))}</p>
    </article>
  `;
}

const FILTERS = {
  all: () => true,
  paid: (o) => isPaid(o) && o.status !== "CANCELLED",
  awaiting: (o) => o.status === "AWAITING_PAYMENT",
  failed: (o) => o.status === "CANCELLED" || (o.payment && ["FAILED", "EXPIRED", "REFUNDED"].includes(o.payment.status)),
  attention: (o) => openIssues(o).length > 0,
};

function renderFilters(orders) {
  const attention = orders.filter(FILTERS.attention).length;
  const badge = qs("#tab-orders-badge");
  badge.hidden = !attention;
  badge.textContent = String(attention);
  badge.setAttribute("aria-label", `${attention} need attention`);
  qsa("[data-filter]").forEach((btn) => {
    const key = btn.dataset.filter;
    const n = orders.filter(FILTERS[key]).length;
    btn.querySelector(".filter-count").textContent = String(n);
    btn.setAttribute("aria-pressed", String(orderFilter === key));
    if (key === "attention") btn.classList.toggle("has-items", n > 0);
  });
}

function renderOrders(allOrders) {
  lastOrders = allOrders;
  renderFilters(allOrders);
  const orders = allOrders.filter(FILTERS[orderFilter]);
  const list = qs("#orders-list");
  qs("#order-count").textContent = String(allOrders.length);

  // seenOrderIds must be initialized on every first call regardless of
  // whether there happen to be zero orders yet — otherwise a store with no
  // orders at unlock time would never leave "first load" state, and the
  // very first real order would be silently treated as already-seen.
  const isFirstLoad = seenOrderIds === null;
  if (isFirstLoad) seenOrderIds = new Set();

  // "New order" = newly PAID (an unpaid order isn't something to cook yet).
  const paidNow = allOrders.filter((o) => isPaid(o) && o.status !== "CANCELLED");
  const newOnes = paidNow.filter((o) => !seenOrderIds.has(o.orderId));
  paidNow.forEach((o) => seenOrderIds.add(o.orderId));

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

  if (orders.length === 0) {
    list.innerHTML = `<p class="empty-note">${allOrders.length ? "No orders in this view." : "No orders yet."}</p>`;
    return;
  }

  // Keep any "payment attempts" lists the owner opened open across refreshes.
  const openAttempts = new Set(qsa(".pay-attempts[open]", list).map((d) => d.closest(".order-card").dataset.orderId));
  list.innerHTML = orders.map((o) => orderCardMarkup(o, !isFirstLoad && newOnes.some((n) => n.orderId === o.orderId))).join("");
  qsa(".order-card", list).forEach((card) => {
    const details = card.querySelector(".pay-attempts");
    if (details && openAttempts.has(card.dataset.orderId)) details.open = true;
  });

  qsa("[data-reconcile]", list).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.closest(".order-card").dataset.orderId;
      btn.disabled = true;
      btn.textContent = "Checking…";
      try {
        const res = await adminFetch(`/api/admin/orders/${orderId}/reconcile`, { method: "POST" });
        if (res.status === 401) return handleAuthFailure();
        const data = await res.json().catch(() => ({}));
        if (!res.ok) announce(data.error || "Couldn't check the payment.");
      } finally {
        fetchOrders();
      }
    });
  });

  qsa("[data-resolve]", list).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = btn.closest(".order-card").dataset.orderId;
      btn.disabled = true;
      try {
        const res = await adminFetch(`/api/admin/orders/${orderId}/issues/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: btn.dataset.resolve, paymentId: btn.dataset.payment || undefined }),
        });
        if (res.status === 401) return handleAuthFailure();
      } finally {
        fetchOrders();
      }
    });
  });

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
    if (data.payments) {
      paymentsInfo = data.payments;
      qs("#payment-mode").innerHTML = paymentsInfo.isLive
        ? `<span class="mode-live">Live</span> — payments via ${escapeHtml(paymentsInfo.provider)}`
        : `<span class="mode-demo">Demo payments</span> — no real money yet`;
    }
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

async function fetchUnmatchedPayments() {
  try {
    const res = await adminFetch("/api/admin/payment-issues");
    if (!res.ok) return;
    const { unmatched } = await res.json();
    const panel = qs("#unmatched-panel");
    panel.hidden = !unmatched.length;
    qs("#unmatched-list").innerHTML = unmatched
      .map(
        (u) => `<div class="unmatched-row">
          <div><strong>${rupees(u.amountPaise)}</strong> · ${escapeHtml((u.method || "").toUpperCase() || "payment")} · ${escapeHtml(u.status)} · ${escapeHtml(when(u.seenAt))}</div>
          <div class="att-ref">Payment <code>${escapeHtml(u.paymentId)}</code>${u.gatewayOrderId ? ` · gateway order <code>${escapeHtml(u.gatewayOrderId)}</code>` : ""}</div>
          <button type="button" class="pay-link" data-unmatched="${escapeHtml(u.paymentId)}">Mark as handled</button>
        </div>`
      )
      .join("");
    qsa("[data-unmatched]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await adminFetch(`/api/admin/payment-issues/${encodeURIComponent(btn.dataset.unmatched)}/resolve`, { method: "POST" }).catch(() => {});
        fetchUnmatchedPayments();
      })
    );
  } catch (_e) {
    /* non-critical */
  }
}

function poll() {
  fetchOrders();
  fetchNotifications();
  fetchUnmatchedPayments();
}

qsa("[data-filter]").forEach((btn) =>
  btn.addEventListener("click", () => {
    orderFilter = btn.dataset.filter;
    renderOrders(lastOrders);
  })
);

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
  if (activeTab === "revenue") fetchRevenue();
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

// ---------------------------------------------------------------------
// Review QR card — the QR opens the public review page (/review); the
// card itself is owner-only, fetched with the admin credential.
// ---------------------------------------------------------------------
let qrObjectUrl = null;
async function loadReviewQr() {
  const warn = qs("#qr-warn");
  warn.hidden = true;
  const [infoRes, svgRes] = await Promise.all([adminFetch("/api/admin/review-qr.json"), adminFetch("/api/admin/review-qr.svg")]).catch(() => [null, null]);
  if (!infoRes || !svgRes || !infoRes.ok || !svgRes.ok) {
    if ((infoRes && infoRes.status === 401) || (svgRes && svgRes.status === 401)) return handleAuthFailure();
    warn.textContent = "Couldn't load the QR code. Please try again.";
    warn.hidden = false;
    return;
  }
  const { reviewPageUrl } = await infoRes.json();
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = URL.createObjectURL(await svgRes.blob());
  qs("#qr-img").src = qrObjectUrl;
  qs("#qr-url").textContent = reviewPageUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (/^https?:\/\/(localhost|127\.|\[::1\])/.test(reviewPageUrl)) {
    warn.textContent = "This QR points at localhost, which phones can't open. Set PUBLIC_SITE_URL to your real domain before printing.";
    warn.hidden = false;
  }
}
qs("#qr-toggle").addEventListener("click", () => {
  const panel = qs("#qr-panel");
  panel.hidden = !panel.hidden;
  qs("#qr-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) loadReviewQr();
});
qs("#qr-print").addEventListener("click", () => {
  document.body.classList.add("printing-qr");
  window.print();
});
window.addEventListener("afterprint", () => document.body.classList.remove("printing-qr"));
qs("#qr-download").addEventListener("click", async () => {
  const btn = qs("#qr-download");
  btn.disabled = true;
  try {
    const res = await adminFetch("/api/admin/review-qr.png");
    if (res.status === 401) return handleAuthFailure();
    if (!res.ok) throw new Error("bad status");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "de25-review-qr.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (_e) {
    qs("#qr-warn").textContent = "Couldn't download the QR code. Please try again.";
    qs("#qr-warn").hidden = false;
  } finally {
    btn.disabled = false;
  }
});

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


// ---------------------------------------------------------------------
// Tabs: Orders / Revenue / Notifications (orders keep polling on every
// tab so new-order alerts still sound).
// ---------------------------------------------------------------------
const TAB_KEY = "de25_admin_tab";
let activeTab = "orders";
let revenueData = null;
let revenueRange = "daily";
let revenueTimer = null;

function selectTab(name, { focus = false } = {}) {
  activeTab = name;
  qsa("[data-tab]").forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus();
    qs(`#${btn.getAttribute("aria-controls")}`).hidden = !on;
  });
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch (_e) {
    /* per-viewer convenience only */
  }
  if (revenueTimer) clearInterval(revenueTimer);
  revenueTimer = null;
  if (name === "revenue") {
    fetchRevenue();
    revenueTimer = setInterval(fetchRevenue, 60000);
  }
}
qsa("[data-tab]").forEach((btn) => btn.addEventListener("click", () => selectTab(btn.dataset.tab)));
qs(".dash-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const tabs = qsa("[data-tab]");
  const i = tabs.findIndex((t) => t.dataset.tab === activeTab);
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(next.dataset.tab, { focus: true });
});
try {
  const saved = localStorage.getItem(TAB_KEY);
  if (saved && qs(`[data-tab="${saved}"]`)) selectTab(saved);
} catch (_e) {
  /* default tab */
}

// ---------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const inr = (paise) => formatCurrency(Math.round((Number(paise) || 0) / 100));
function compactInr(paise) {
  const r = (Number(paise) || 0) / 100;
  const short = (n, digits) => n.toFixed(digits).replace(/\.0$/, "");
  if (r >= 1e7) return `₹${short(r / 1e7, r >= 1e8 ? 0 : 1)}Cr`;
  if (r >= 1e5) return `₹${short(r / 1e5, r >= 1e6 ? 0 : 1)}L`;
  if (r >= 1e3) return `₹${short(r / 1e3, r >= 1e4 ? 0 : 1)}k`;
  return `₹${Math.round(r)}`;
}
function bucketLabel(range, key, { long = false } = {}) {
  if (range === "yearly") return key;
  if (range === "monthly") {
    const [y, m] = key.split("-");
    return long ? `${MONTHS[Number(m) - 1]} ${y}` : `${MONTHS[Number(m) - 1]}${m === "01" ? ` '${y.slice(2)}` : ""}`;
  }
  const [y, m, d] = key.split("-");
  return long ? `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}` : `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}
/** Axis scale: 4 even steps of a round rupee amount (₹1/2/5 × 10ⁿ) covering the max. */
function niceScale(maxPaise) {
  const raw = Math.max(maxPaise / 100, 1000) / 4; // empty chart still gets a ₹0–1k axis
  const mag = 10 ** Math.floor(Math.log10(raw));
  const stepRupees = [1, 2, 5, 10].find((s) => s * mag >= raw) * mag;
  const steps = Math.ceil(maxPaise / 100 / stepRupees) || 4;
  return { stepPaise: stepRupees * 100, steps: Math.max(steps, 1) };
}
function delta(cur, prev, label) {
  if (!prev.revenuePaise) return cur.revenuePaise ? `No sales ${label} to compare` : `No sales ${label} either`;
  const pct = Math.round(((cur.revenuePaise - prev.revenuePaise) / prev.revenuePaise) * 100);
  return `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs ${label} (${inr(prev.revenuePaise)})`;
}

function renderRevenueTiles(d) {
  const s = d.summary;
  const tile = (label, b, prev, prevLabel, fullPrev) => `
    <div class="rev-tile">
      <p class="rev-tile-label">${label}</p>
      <p class="rev-tile-value">${inr(b.revenuePaise)}</p>
      <p class="rev-tile-meta">${b.orders} paid order${b.orders === 1 ? "" : "s"}${b.orders ? ` · avg ${inr(b.revenuePaise / b.orders)}` : ""}${b.refundsPaise ? ` · ${inr(b.refundsPaise)} refunded` : ""}</p>
      <p class="rev-delta">${escapeHtml(delta(b, prev, prevLabel))}</p>
      ${fullPrev ? `<p class="rev-tile-meta">${escapeHtml(fullPrev[0])}: ${inr(fullPrev[1].revenuePaise)}</p>` : ""}
    </div>`;
  qs("#rev-tiles").innerHTML =
    tile("Today", s.today, s.yesterday, "yesterday") +
    tile("This month", s.thisMonth, s.lastMonthToDate, "same days last month", ["Last month total", s.lastMonth]) +
    tile("This year", s.thisYear, s.lastYearToDate, "same point last year", ["Last year total", s.lastYear]);
}

function renderRevenueChart() {
  const d = revenueData;
  const series = d[revenueRange];
  const titles = { daily: "Daily revenue — last 30 days", monthly: "Monthly revenue — last 12 months", yearly: "Yearly revenue" };
  qs("#rev-chart-title").textContent = titles[revenueRange];
  qsa("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === revenueRange)));

  const { stepPaise, steps } = niceScale(Math.max(...series.map((x) => x.revenuePaise), 0));
  const max = stepPaise * steps;
  const ticks = Array.from({ length: steps + 1 }, (_, i) => i / steps);
  // Selective x labels (always including the latest), as many as fit — ~60px each.
  const fit = Math.max(3, Math.floor((qs("#rev-chart").clientWidth - 52) / 60));
  const every = Math.max(1, Math.ceil(series.length / fit));
  const labelled = (i) => (series.length - 1 - i) % every === 0;
  const allZero = series.every((x) => !x.revenuePaise);

  qs("#rev-chart").innerHTML = `
    <div class="rev-yaxis" aria-hidden="true">${ticks.map((t) => `<span style="bottom:${t * 100}%">${compactInr(max * t)}</span>`).join("")}</div>
    <div class="rev-plot">
      ${ticks.slice(1).map((t) => `<div class="rev-grid" style="bottom:${t * 100}%"></div>`).join("")}
      <div class="rev-bars">${series
        .map(
          (x, i) => `<button type="button" class="rev-col" data-i="${i}" aria-label="${escapeHtml(
            `${bucketLabel(revenueRange, x.key, { long: true })}: ${inr(x.revenuePaise)}, ${x.orders} orders`
          )}"><span class="rev-bar" style="height:${x.revenuePaise > 0 ? Math.max(1.5, (x.revenuePaise / max) * 100) : 0}%"></span></button>`
        )
        .join("")}</div>
      ${allZero ? `<div class="rev-empty">No paid orders in this period yet</div>` : ""}
      <div class="rev-tip" id="rev-tip" hidden></div>
    </div>
    <div class="rev-xaxis" aria-hidden="true">${series
      .map((x, i) => `<span>${labelled(i) ? escapeHtml(bucketLabel(revenueRange, x.key)) : ""}</span>`)
      .join("")}</div>`;

  const tip = qs("#rev-tip");
  const plot = qs(".rev-plot");
  const show = (col) => {
    const x = series[Number(col.dataset.i)];
    qsa(".rev-col.is-active").forEach((c) => c.classList.remove("is-active"));
    col.classList.add("is-active");
    tip.innerHTML = `<div>${escapeHtml(bucketLabel(revenueRange, x.key, { long: true }))}</div><strong>${inr(x.revenuePaise)}</strong><div>${x.orders} paid order${x.orders === 1 ? "" : "s"}${
      x.refundsPaise ? ` · ${inr(x.refundsPaise)} refunded` : ""
    }</div>`;
    const pr = plot.getBoundingClientRect();
    const cr = col.getBoundingClientRect();
    const bar = col.firstElementChild.getBoundingClientRect();
    const left = Math.min(Math.max(cr.left + cr.width / 2 - pr.left, 70), pr.width - 70);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.min(bar.top - pr.top, pr.height - 10)}px`;
    tip.hidden = false;
  };
  const hide = () => {
    tip.hidden = true;
    qsa(".rev-col.is-active").forEach((c) => c.classList.remove("is-active"));
  };
  qsa(".rev-col").forEach((col) => {
    col.addEventListener("mouseenter", () => show(col));
    col.addEventListener("focus", () => show(col));
    col.addEventListener("click", () => show(col));
    col.addEventListener("blur", hide);
  });
  plot.addEventListener("mouseleave", hide);

  qs("#rev-table").innerHTML = `<thead><tr><th scope="col">${revenueRange === "daily" ? "Day" : revenueRange === "monthly" ? "Month" : "Year"}</th><th scope="col">Revenue</th><th scope="col">Paid orders</th><th scope="col">Refunded</th></tr></thead><tbody>${series
    .slice()
    .reverse()
    .map((x) => `<tr><td>${escapeHtml(bucketLabel(revenueRange, x.key, { long: true }))}</td><td>${inr(x.revenuePaise)}</td><td>${x.orders}</td><td>${x.refundsPaise ? inr(x.refundsPaise) : "—"}</td></tr>`)
    .join("")}</tbody>`;
}

function renderTopItems(listEl, items) {
  listEl.innerHTML = items.length
    ? items.map((i) => `<li>${escapeHtml(i.name)} <span>· ${i.qty} sold · ${inr(i.revenuePaise)}</span></li>`).join("")
    : `<li class="empty">No sales yet</li>`;
}

async function fetchRevenue() {
  if (qs("#dashboard").hidden) return; // locked / not signed in yet
  try {
    const res = await adminFetch("/api/admin/revenue");
    if (res.status === 401) return handleAuthFailure();
    if (!res.ok) throw new Error("bad status");
    revenueData = await res.json();
    qs("#revenue-basis").textContent = `Paid orders only, after refunds · India time${
      revenueData.excludesDemo ? " · demo test orders excluded" : paymentsInfo.isLive ? "" : " · includes demo payments (no real money yet)"
    }`;
    renderRevenueTiles(revenueData);
    renderRevenueChart();
    renderTopItems(qs("#rev-top-month"), revenueData.topItems.thisMonth);
    renderTopItems(qs("#rev-top-year"), revenueData.topItems.thisYear);
  } catch (_e) {
    qs("#rev-tiles").innerHTML = `<p class="empty-note">Couldn't load revenue. It will retry in a minute.</p>`;
  }
}
qsa("[data-range]").forEach((btn) =>
  btn.addEventListener("click", () => {
    revenueRange = btn.dataset.range;
    if (revenueData) renderRevenueChart();
  })
);
let revenueResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(revenueResizeTimer);
  revenueResizeTimer = setTimeout(() => {
    if (revenueData && activeTab === "revenue") renderRevenueChart();
  }, 150);
});
