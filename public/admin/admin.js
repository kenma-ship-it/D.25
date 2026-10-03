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
// Outside the kitchen's progression (server/orders/statuses.js): an order
// waits in AWAITING_PAYMENT until it's paid, and is CANCELLED if it never is.
Object.assign(STATUS_LABELS, { AWAITING_PAYMENT: "Awaiting Payment", CANCELLED: "Cancelled" });

// Orders already announced with the chime/banner. Only paid orders count,
// so an abandoned checkout never sets off the alarm.
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

/** Only ever link to Borzo's own https tracking pages. */
function safeTrackingUrl(url) {
  return typeof url === "string" && /^https:\/\/(?:[a-z0-9-]+\.)*borzodelivery\.com\//i.test(url) ? url : null;
}

const ENV_LABELS = { test: "Borzo sandbox", production: "Borzo LIVE" };

/** What happened to the courier booking for this order, from order.delivery. */
function courierBoxMarkup(order) {
  const d = order.delivery;
  if (!d) {
    const isLive = Boolean(order.deliveryQuote && order.deliveryQuote.isLive);
    return `<p class="delivery-note">${
      isLive ? "Booking courier with Borzo…" : "Demo delivery estimate — DE.25 is handling delivery directly for now."
    }</p>`;
  }
  if (d.status === "failed") {
    return `<div class="courier-box is-failed"><strong>Courier booking failed</strong> (${escapeHtml(ENV_LABELS[d.environment] || d.provider)})
      <div class="courier-meta">${escapeHtml(d.error || "Unknown error")}</div></div>`;
  }
  if (d.provider !== "borzo") {
    return `<div class="courier-box"><strong>Simulated delivery</strong> — no courier booked
      <div class="courier-meta">${escapeHtml(d.deliveryOrderId || "")} · enable Borzo to book real couriers</div></div>`;
  }
  const tracking = safeTrackingUrl(d.trackingUrl);
  const courier = d.courier
    ? ` · ${escapeHtml(d.courier.name)}${d.courier.phone ? ` · <a href="tel:${escapeHtml(d.courier.phone)}">${escapeHtml(d.courier.phone)}</a>` : ""}`
    : "";
  const synced = d.lastSyncedAt ? ` · synced ${timeAgo(d.lastSyncedAt)}` : "";
  return `<div class="courier-box is-borzo">
      <strong>${escapeHtml(ENV_LABELS[d.environment] || "Borzo")} #${escapeHtml(d.deliveryOrderId)}</strong> — ${escapeHtml(d.statusLabel || d.status)}${courier}
      <div class="courier-meta">Borzo status "${escapeHtml(d.borzoStatus || "—")}"${d.feeRupees != null ? ` · fee ${formatCurrency(d.feeRupees)}` : ""}${synced}${
        tracking ? ` · <a href="${escapeHtml(tracking)}" target="_blank" rel="noopener noreferrer">Tracking page ↗</a>` : ""
      }</div></div>`;
}

function rupees(paise) {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function clockTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
}

/** An order the owner should hear about: a paid one. */
function needsOwner(order) {
  return order.status !== "CANCELLED" && order.status !== "AWAITING_PAYMENT";
}

function paymentMethodLabel(order) {
  const p = order.payment;
  if (order.isSample) return "Sample · no payment";
  if (!p) return "Online payment";
  return { razorpay: "Razorpay", demo: "Demo payment" }[p.method] || p.method;
}

// How Razorpay's word reached the server — the owner never confirms by hand.
const VERIFIED_BY = {
  "razorpay-signature": "confirmed automatically (checkout signature)",
  "razorpay-webhook": "confirmed automatically (Razorpay webhook)",
  "razorpay-api": "confirmed automatically (checked with Razorpay)",
};

/** Where the money stands for this order. */
function paymentBoxMarkup(order) {
  const p = order.payment;
  if (!p && !order.isSample) return "";
  const amount = p ? rupees(p.amountPaise) : "";
  const box = (cls, title, meta, extra = "") =>
    `<div class="payment-box ${cls}"><strong>${title}</strong>${meta ? `<div class="payment-meta">${meta}</div>` : ""}${extra}</div>`;

  if (order.isSample) return box("is-off", "No payment — sample order", "Placed from this dashboard to exercise the order flow.");
  if (p.status === "paid" && p.simulated) {
    return box("is-off", `Simulated payment <span class="pay-tag">no money received</span>`, "Demo mode — no payment gateway is connected.");
  }

  if (p.method === "razorpay") {
    const test = p.mode === "test" ? `<span class="pay-tag">test mode · no real money</span>` : "";
    if (p.status === "paid") {
      const meta = [
        `<code>${escapeHtml(p.paymentId || "")}</code>`,
        p.gatewayMethod ? escapeHtml(p.gatewayMethod) : null,
        p.gatewayStatus ? `Razorpay status "${escapeHtml(p.gatewayStatus)}"` : null,
        `paid ${clockTime(p.paidAt)}`,
        VERIFIED_BY[p.verifiedBy] || null,
        p.paidAfterExpiry ? "arrived after the payment window — honoured" : null,
      ].filter(Boolean);
      const anomaly = p.anomaly ? `<div class="payment-warn">Check this payment in the Razorpay dashboard: ${escapeHtml(p.anomaly)}</div>` : "";
      return box("is-paid", `Paid ${amount} via Razorpay ${test}`, meta.join(" · "), anomaly);
    }
    if (order.status === "AWAITING_PAYMENT") {
      const err = p.lastError && p.lastError.description ? ` · last attempt failed: ${escapeHtml(p.lastError.description)}` : "";
      return box("", `Waiting for ${amount} via Razorpay ${test}`, `Cancelled automatically at ${clockTime(p.expiresAt)} if unpaid${err}`);
    }
    return box("is-off", "Not paid — order cancelled", p.status === "failed" ? "Razorpay couldn't start the payment." : "Payment window closed without a payment.");
  }

  if (order.status === "AWAITING_PAYMENT") return box("", `Waiting for a simulated payment of ${amount}`, "Demo mode — no money moves.");
  return box("is-off", "Not paid — order cancelled", "");
}

function advanceLabel(order, currentIndex, isFinal) {
  if (order.status === "AWAITING_PAYMENT") return "Waiting for payment";
  if (order.status === "CANCELLED") return "Cancelled";
  return isFinal ? "Delivered" : `Mark as ${escapeHtml(STATUS_LABELS[STATUS_ORDER[currentIndex + 1]] || "next step")}`;
}

function orderCardMarkup(order, isNew) {
  const addr = order.address;
  const addressLine = [addr.house, addr.street, addr.area, addr.city, addr.pincode].filter(Boolean).join(", ");
  const currentIndex = STATUS_ORDER.indexOf(order.status);
  const isFinal = currentIndex === STATUS_ORDER.length - 1;
  const canAdvance = currentIndex !== -1 && !isFinal;
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
          <div class="order-token">${escapeHtml(order.token)}${order.isSample ? `<span class="sample-tag">Sample</span>` : ""}</div>
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
      ${paymentBoxMarkup(order)}
      <div class="order-foot">
        <span class="payment-tag">${escapeHtml(paymentMethodLabel(order))}</span>
        <button type="button" class="advance-btn" data-advance ${canAdvance ? "" : "disabled"}>
          ${advanceLabel(order, currentIndex, isFinal)}
        </button>
      </div>
      ${courierBoxMarkup(order)}
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

  const actionable = orders.filter(needsOwner);
  const newOnes = actionable.filter((o) => !seenOrderIds.has(o.orderId));
  actionable.forEach((o) => seenOrderIds.add(o.orderId));

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
    const one = newOnes[0];
    const summary =
      newOnes.length === 1
        ? `New paid order: ${one.token} — ${one.customer.name} — ${formatCurrency(one.total)}`
        : `${newOnes.length} orders need you!`;
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

// ---------------------------------------------------------------------
// Borzo panel — config checklist, real API traffic, connection check and
// sample orders. Everything shown comes from GET /api/admin/borzo; the
// activity log there only ever contains real network exchanges.
// ---------------------------------------------------------------------
const BORZO_POLL_MS = 10000; // keeps the dashboard well under the API's 60/min limit
const PURPOSE_LABELS = {
  "connection-check": "connection check",
  quote: "delivery quote",
  "create-order": "customer order",
  "sample-order": "sample order",
  "status-sync": "status sync",
  status: "status lookup",
  cancel: "cancellation",
};
let borzoTimer = null;
let borzoState = null;
let sampleBusy = false; // a refresh must not re-enable the button mid-request
const openActivityIds = new Set(); // keep expanded rows open across refreshes

function renderBorzoMode(activeProvider, cfg) {
  const pill = qs("#borzo-mode");
  pill.classList.remove("is-demo", "is-sandbox", "is-production");
  if (activeProvider !== "borzo") {
    pill.textContent = "Demo — no courier booked";
    pill.classList.add("is-demo");
  } else if (cfg.environment === "production") {
    pill.textContent = "Production — real couriers";
    pill.classList.add("is-production");
  } else {
    pill.textContent = "Sandbox — test orders";
    pill.classList.add("is-sandbox");
  }
}

function renderBorzoChecklist(cfg) {
  const items = [
    [cfg.enabled, "<code>BORZO_DELIVERY_ENABLED=true</code>"],
    [cfg.hasToken, "Borzo API token set (server-side only)"],
    [cfg.pickupAddressSet, "Kitchen pickup address (<code>PICKUP_ADDRESS</code>)"],
    [cfg.pickupPhoneSet, "Kitchen pickup phone (<code>PICKUP_PHONE</code>)"],
    [
      cfg.environment === "test" || cfg.liveConfirmed,
      cfg.environment === "production"
        ? "Production confirmed (<code>BORZO_LIVE_CONFIRM</code>)"
        : "Environment: sandbox (<code>BORZO_ENV=test</code>)",
    ],
  ];
  qs("#borzo-checklist").innerHTML = items
    .map(([ok, label]) => `<li class="${ok ? "ok" : "missing"}"><span class="mark" aria-label="${ok ? "done" : "missing"}">${ok ? "✓" : "✗"}</span><span>${label}</span></li>`)
    .join("");
}

function renderBorzoStats(stats) {
  const rows = [
    ["Real API calls", stats.total],
    ["Accepted", stats.succeeded],
    ["Rejected by Borzo", stats.rejected],
    ["Network errors", stats.networkErrors],
    ["Median latency", stats.medianLatencyMs != null ? `${stats.medianLatencyMs} ms` : "—"],
    ["Borzo orders created", stats.ordersCreated],
    ["Last call", stats.lastCallAt ? timeAgo(stats.lastCallAt) : "—"],
  ];
  qs("#borzo-stats").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join("");
}

function renderSampleControls(activeProvider, cfg) {
  const btn = qs("#borzo-sample-btn");
  const hint = qs("#sample-hint");
  if (activeProvider === "borzo" && cfg.environment === "production") {
    btn.disabled = true;
    hint.textContent = "Disabled on production — samples would dispatch real riders.";
  } else if (activeProvider === "borzo") {
    btn.disabled = sampleBusy;
    hint.textContent = "Places real Borzo sandbox orders (real order ids and tracking pages; no rider, no charge).";
  } else {
    btn.disabled = sampleBusy;
    hint.textContent = "Borzo isn't active, so these run through the full checkout but the courier booking is simulated.";
  }
}

function httpClass(entry) {
  if (entry.outcome === "success") return "ok";
  if (entry.outcome === "api_error") return "rejected";
  return "failed";
}

function activityRowMarkup(e) {
  const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const host = (e.host || "").replace(/^https:\/\//, "");
  const request = e.request ? JSON.stringify(e.request, null, 2) : "(GET — parameters in the URL)";
  const response = e.response == null ? "(no response)" : typeof e.response === "string" ? e.response : JSON.stringify(e.response, null, 2);
  return `
    <li>
      <details class="activity-row" data-activity-id="${escapeHtml(e.id)}"${openActivityIds.has(e.id) ? " open" : ""}>
        <summary>
          <span class="activity-time">${escapeHtml(time)}</span>
          <span class="activity-call">${escapeHtml(e.method)} ${escapeHtml(e.endpoint)}<span class="env-tag env-${escapeHtml(e.environment)}">${e.environment === "production" ? "production" : "sandbox"}</span></span>
          <span class="activity-figures">
            <span class="http-code ${httpClass(e)}">${e.httpStatus ? `HTTP ${e.httpStatus}` : "no reply"}</span>
            <span>${escapeHtml(String(e.latencyMs))} ms</span>
          </span>
          <span class="activity-summary"><span class="activity-purpose">${escapeHtml(PURPOSE_LABELS[e.purpose] || e.purpose || "")}${e.authenticated ? "" : " · no token sent"} ·</span> ${escapeHtml(e.summary || "")}</span>
        </summary>
        <div class="activity-detail">
          <div><div class="detail-label">Request · ${escapeHtml(host)}${escapeHtml(e.path || "")}</div><pre>${escapeHtml(request)}</pre></div>
          <div><div class="detail-label">Borzo's response</div><pre>${escapeHtml(response)}</pre></div>
        </div>
      </details>
    </li>`;
}

function renderBorzoActivity(entries) {
  const list = qs("#borzo-activity");
  if (!entries.length) {
    list.innerHTML = `<li class="empty-note">No calls to Borzo yet. Run the live connection check to make the first one.</li>`;
    return;
  }
  list.innerHTML = entries.map(activityRowMarkup).join("");
  qsa("details[data-activity-id]", list).forEach((el) => {
    el.addEventListener("toggle", () => {
      if (el.open) openActivityIds.add(el.dataset.activityId);
      else openActivityIds.delete(el.dataset.activityId);
    });
  });
}

function renderLastSync(activeProvider, lastSync) {
  const el = qs("#borzo-last-sync");
  if (activeProvider !== "borzo") {
    el.textContent = "Status sync runs once Borzo is active";
  } else if (!lastSync) {
    el.textContent = "Status sync: waiting for first run";
  } else if (lastSync.error) {
    el.textContent = `Status sync failed ${timeAgo(lastSync.at)}: ${lastSync.error}`;
  } else {
    el.textContent = `Status sync ${timeAgo(lastSync.at)} · ${lastSync.checked} open deliveries checked`;
  }
}

async function fetchBorzo() {
  try {
    const res = await adminFetch("/api/admin/borzo");
    if (!res.ok) return;
    borzoState = await res.json();
    renderBorzoMode(borzoState.activeProvider, borzoState.config);
    renderBorzoChecklist(borzoState.config);
    renderBorzoStats(borzoState.stats);
    renderSampleControls(borzoState.activeProvider, borzoState.config);
    renderLastSync(borzoState.activeProvider, borzoState.lastSync);
    renderBorzoActivity(borzoState.activity || []);
  } catch (_e) {
    /* non-critical — retried on the next tick */
  }
}

function setActionMessage(text, isError = false) {
  const el = qs("#borzo-action-msg");
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

function renderCheckResult(result) {
  const box = qs("#borzo-check-result");
  box.innerHTML = result.hosts
    .map(
      (h) => `
      <div class="check-host ${h.reachable ? "reachable" : "unreachable"}">
        <strong>${h.environment === "production" ? "Production" : "Sandbox"} — ${escapeHtml(h.verdict)}</strong>
        <div class="check-url">POST ${escapeHtml(h.host)}/…/calculate-order</div>
        <div class="check-figures"><span>${h.httpStatus ? `HTTP ${h.httpStatus}` : "No reply"}</span><span>${escapeHtml(String(h.latencyMs))} ms round trip</span>${
          h.errors && h.errors.length ? `<span>${escapeHtml(h.errors.join(", "))}</span>` : ""
        }</div>
        <div class="action-hint">${h.authenticated ? "Sent with your token" : "Sent without a token"} · ${new Date(result.startedAt).toLocaleTimeString()}</div>
      </div>`
    )
    .join("");
  box.hidden = false;
}

qs("#borzo-check-btn").addEventListener("click", async () => {
  const btn = qs("#borzo-check-btn");
  btn.disabled = true;
  setActionMessage("Calling Borzo's sandbox and production servers…");
  try {
    const res = await adminFetch("/api/admin/borzo/check", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setActionMessage(data.error || "Connection check failed.", true);
    } else {
      renderCheckResult(data);
      const up = data.hosts.filter((h) => h.reachable).length;
      setActionMessage(`${up} of ${data.hosts.length} Borzo hosts answered.`);
      announce(`Connection check finished: ${up} of ${data.hosts.length} Borzo hosts answered.`);
    }
  } catch (_e) {
    setActionMessage("Couldn't reach this server.", true);
  } finally {
    btn.disabled = false;
    fetchBorzo();
  }
});

qs("#borzo-sample-btn").addEventListener("click", async () => {
  const btn = qs("#borzo-sample-btn");
  const count = Number(qs("#sample-count").value) || 1;
  sampleBusy = true;
  btn.disabled = true;
  setActionMessage(`Placing ${count} sample order${count === 1 ? "" : "s"} through checkout…`);
  try {
    const res = await adminFetch("/api/admin/borzo/sample-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setActionMessage(data.error || "Sample orders failed.", true);
    } else {
      const ok = data.results.filter((r) => r.ok);
      const failed = data.results.filter((r) => !r.ok);
      const where = data.provider === "borzo" ? "booked in the Borzo sandbox" : "placed (courier simulated)";
      let msg = `${ok.length} of ${data.results.length} sample orders ${where}.`;
      if (ok.length && data.provider === "borzo") msg += ` Borzo ids: ${ok.map((r) => `#${r.delivery.deliveryOrderId}`).join(", ")}.`;
      if (failed.length) msg += ` Failed: ${failed.map((r) => r.error || (r.delivery && r.delivery.error) || "unknown").join("; ")}`;
      setActionMessage(msg, failed.length > 0 && ok.length === 0);
    }
  } catch (_e) {
    setActionMessage("Couldn't reach this server.", true);
  } finally {
    sampleBusy = false;
    btn.disabled = false;
    fetchOrders();
    fetchNotifications();
    fetchBorzo();
  }
});

// ---------------------------------------------------------------------
// Payments panel — how money is collected, from GET /api/admin/payments.
// Secrets never reach the browser: only "set / not set" and a key-id hint.
// ---------------------------------------------------------------------
function renderPaymentsMode(cfg) {
  const pill = qs("#payments-mode");
  pill.classList.remove("is-demo", "is-sandbox", "is-production", "is-live");
  const [text, cls] =
    cfg.method === "razorpay"
      ? cfg.razorpay.mode === "live"
        ? ["Razorpay LIVE — real money", "is-live"]
        : ["Razorpay test mode — no real money", "is-sandbox"]
      : cfg.method === "demo"
        ? ["Demo — payments are simulated", "is-demo"]
        : ["Checkout OFF — no working payment method", "is-production"];
  pill.textContent = text;
  pill.classList.add(cls);
}

function renderPaymentsChecklist(cfg) {
  const item = (ok, label) => [ok, label];
  let items;
  if (cfg.method === "razorpay" || cfg.requested === "razorpay") {
    const r = cfg.razorpay;
    items = [
      item(Boolean(r.keyIdHint), r.keyIdHint ? `Key id <code>${escapeHtml(r.keyIdHint)}</code>` : "<code>RAZORPAY_KEY_ID</code>"),
      item(r.hasKeySecret, "Key secret set (server-side only)"),
      item(r.mode === "live", r.mode === "live" ? "Live keys — real payments" : "Test keys — switch to live keys after Razorpay KYC"),
      item(r.hasWebhookSecret, "Webhook secret (<code>RAZORPAY_WEBHOOK_SECRET</code>) — needs a public https URL"),
    ];
  } else {
    items = [item(false, "Razorpay keys (<code>RAZORPAY_KEY_ID</code> + <code>RAZORPAY_KEY_SECRET</code>)")];
  }
  items.push(item(true, `Unpaid orders cancel after ${escapeHtml(String(cfg.windowMinutes))} min`));
  const problems = (cfg.problems || []).map((p) => `<li class="missing"><span class="mark" aria-label="problem">!</span><span>${escapeHtml(p)}</span></li>`);
  qs("#payments-checklist").innerHTML =
    items.map(([ok, label]) => `<li class="${ok ? "ok" : "missing"}"><span class="mark" aria-label="${ok ? "done" : "missing"}">${ok ? "✓" : "✗"}</span><span>${label}</span></li>`).join("") + problems.join("");
}

function renderPaymentsStats(stats) {
  const rows = [
    ["Waiting for payment", stats.awaiting],
    ["Paid today", stats.paidToday],
    ["Collected today", formatCurrency(stats.collectedTodayRupees)],
    ["Test-mode payments today", stats.testModeToday],
    ["Simulated today", stats.simulatedToday],
    ["Cancelled today", stats.cancelledToday],
  ];
  qs("#payments-stats").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join("");
}

const PAYMENT_HOWTO = {
  razorpay:
    "Customers pay inside Razorpay's window — scan the UPI QR, or use cards, netbanking or wallets. Each order confirms itself once Razorpay's signature checks out (or the server finds the payment with Razorpay within ~15 s) and then chimes here — nothing for you to do. Money settles to your bank account per Razorpay's schedule.",
  demo: "No payment method is configured, so checkout offers a clearly labelled “simulate payment” button. The server refuses simulated payments in production.",
};

function renderPaymentsHowto(cfg) {
  qs("#payments-howto").textContent =
    PAYMENT_HOWTO[cfg.method] || "Checkout is refusing orders until the Razorpay keys are set in .env — see the problems listed under Setup.";
}

async function fetchPayments() {
  try {
    const res = await adminFetch("/api/admin/payments");
    if (!res.ok) return;
    const data = await res.json();
    renderPaymentsMode(data.config);
    renderPaymentsChecklist(data.config);
    renderPaymentsStats(data.stats);
    renderPaymentsHowto(data.config);
  } catch (_e) {
    /* non-critical — retried on the next tick */
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
  fetchBorzo();
  fetchPayments();
  borzoTimer = setInterval(() => {
    fetchBorzo();
    fetchPayments();
  }, BORZO_POLL_MS);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (borzoTimer) clearInterval(borzoTimer);
  pollTimer = null;
  borzoTimer = null;
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
