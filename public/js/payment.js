/**
 * The payment step between checkout and the order tracker. By the time
 * this opens, the server has stored the order as AWAITING_PAYMENT and has
 * decided how money is collected (server/payments/paymentConfig.js) — this
 * screen only collects it:
 *
 *   razorpay  Razorpay Checkout opens straight away: UPI QR first (scan
 *             with any UPI app), then cards, netbanking and wallets. Its
 *             success callback is re-checked on the server against
 *             Razorpay's signature; the browser saying "paid" proves
 *             nothing. A payment whose callback never arrives is still
 *             picked up — the server asks Razorpay every few seconds and
 *             this screen polls the order — so nobody confirms anything
 *             by hand.
 *   demo      No gateway connected: a clearly labelled "simulate" button,
 *             refused by the server in production.
 *
 * The cart is cleared only once the order is paid — leaving this screen
 * early keeps it.
 */
import { api } from "./api.js";
import { escapeHtml, qs, trapFocus, showToast, announce, setBackgroundInert } from "./utils.js";

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
const UNPAID = "AWAITING_PAYMENT";

let releaseFocusTrap = null;
let razorpayScript = null;
// The order being paid for: { placed, onPaid, countdown, poll, expired, done }
let session = null;

/** Exact amount with paise — what the customer must see before paying. */
function payAmount(pay) {
  const rupees = (pay.amountPaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₹${rupees}`;
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

function setError(message) {
  const el = qs("#payment-error");
  el.textContent = message || "";
  el.hidden = !message;
}

function setHint(text) {
  qs("#payment-hint").textContent = text || "";
}

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayScript) {
    razorpayScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = RAZORPAY_SCRIPT;
      script.async = true;
      script.onload = () => (window.Razorpay ? resolve() : reject(new Error("Razorpay didn't load.")));
      script.onerror = () => reject(new Error("Couldn't reach Razorpay. Please check your connection and try again."));
      document.head.appendChild(script);
    }).catch((err) => {
      razorpayScript = null;
      throw err;
    });
  }
  return razorpayScript;
}

// ------------------------------------------------------------- Razorpay ---

function razorpayMarkup(pay) {
  const testBadge =
    pay.mode === "test"
      ? `<p class="pay-badge pay-badge-test">Razorpay test mode &mdash; pay with the UPI ID <code>success@razorpay</code> or a Razorpay test card. No real money moves.</p>`
      : "";
  return `${testBadge}
    <p class="pay-lead">Scan the UPI QR with GPay, PhonePe, Paytm or any UPI app &mdash; or pay by card, netbanking or wallet. Your order confirms itself the moment the payment goes through.</p>
    <button type="button" class="primary-btn pay-main-btn" id="rzp-pay-btn">Pay ${escapeHtml(payAmount(pay))}</button>
    <button type="button" class="pay-link-btn" id="pay-check-btn">I've already paid &mdash; check again</button>`;
}

/**
 * UPI first, as a QR on desktop (and the UPI apps on a phone). The UPI
 * "collect" flow — typing a UPI ID to get a request in the app — is retired
 * by NPCI, so it's hidden for real payments; test mode keeps it because
 * Razorpay's test UPI ID (success@razorpay) is the way to test UPI there.
 */
function checkoutDisplay(pay) {
  return {
    display: {
      blocks: { upi: { name: "Pay with UPI — scan the QR", instruments: [{ method: "upi" }] } },
      sequence: ["block.upi"],
      preferences: { show_default_blocks: true },
      ...(pay.mode === "test" ? {} : { hide: [{ method: "upi", flows: ["collect"] }] }),
    },
  };
}

async function openRazorpay() {
  const { placed } = session;
  const pay = placed.payment;
  const btn = qs("#rzp-pay-btn");
  setError("");
  btn.disabled = true;
  try {
    await loadRazorpay();
  } catch (err) {
    btn.disabled = false;
    setError(err.message);
    return;
  }
  if (!session || session.placed !== placed) return;
  btn.disabled = session.expired;

  const checkout = new window.Razorpay({
    key: pay.keyId,
    amount: pay.amountPaise,
    currency: pay.currency,
    name: pay.merchantName,
    description: pay.description,
    order_id: pay.gatewayOrderId,
    prefill: pay.prefill,
    notes: pay.notes,
    theme: { color: "#24211c" },
    config: checkoutDisplay(pay),
    handler: (response) => verifyRazorpay(placed, response),
    modal: { ondismiss: () => checkRazorpay({ quiet: true }), confirm_close: true },
  });
  checkout.on("payment.failed", (response) => {
    const reason = response && response.error && response.error.description;
    setError(`That payment didn't go through${reason ? `: ${reason}` : ""}. You can try again.`);
  });
  checkout.open();
}

async function verifyRazorpay(placed, response) {
  setError("");
  setHint("Confirming your payment with DE.25…");
  try {
    const summary = await api.razorpayVerify(placed.orderId, {
      razorpay_order_id: response.razorpay_order_id,
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_signature: response.razorpay_signature,
    });
    settle(summary);
  } catch (err) {
    setHint("");
    setError(err.message);
  }
}

async function checkRazorpay({ quiet = false } = {}) {
  if (!session) return;
  const { placed } = session;
  try {
    const summary = await api.razorpayRefresh(placed.orderId);
    if (summary.status !== UNPAID && summary.status !== "CANCELLED") return settle(summary);
    if (!quiet) setHint("No completed payment found yet. If you've just paid, give it a few seconds and check again.");
    else setHint("Payment not completed. Tap Pay to try again.");
  } catch (err) {
    if (!quiet) setError(err.message);
  }
}

// ---------------------------------------------------------------- Demo ---

function demoMarkup() {
  return `
    <p class="pay-badge pay-badge-demo">Demo mode &mdash; no payment gateway is connected</p>
    <p class="pay-lead">This site can't collect money yet. To try the rest of the order flow, simulate a successful payment &mdash; nothing is charged and DE.25 receives nothing.</p>
    <button type="button" class="primary-btn pay-main-btn" id="demo-pay-btn">Simulate payment (no money moves)</button>`;
}

async function simulateDemo() {
  const { placed } = session;
  const btn = qs("#demo-pay-btn");
  btn.disabled = true;
  setError("");
  try {
    settle(await api.demoSimulate(placed.orderId));
  } catch (err) {
    setError(err.message);
    btn.disabled = session ? session.expired : false;
  }
}

// -------------------------------------------------------------- Window ---

const HINTS = {
  razorpay:
    "DE.25 never sees your card details or UPI PIN — Razorpay handles the payment, and DE.25's server checks Razorpay's signature before your order goes to the kitchen.",
  demo: "Demo mode is for trying the site only. A real deployment connects Razorpay, and the server refuses simulated payments in production.",
};

const EXPIRED_TEXT = {
  razorpay: "Time's up — this order was cancelled. Already paid? Tap “check again”: a late payment is still honoured.",
  demo: "Time's up — this order was cancelled. Close this and place the order again.",
};

function markExpired() {
  if (!session || session.expired) return;
  session.expired = true;
  const method = session.placed.payment.method;
  const el = qs("#payment-expiry");
  el.textContent = EXPIRED_TEXT[method] || EXPIRED_TEXT.demo;
  el.dataset.state = "expired";
  ["#rzp-pay-btn", "#demo-pay-btn"].forEach((sel) => {
    const btn = qs(sel);
    if (btn) btn.disabled = true;
  });
  announce(el.textContent);
}

function tickCountdown() {
  if (!session || session.expired) return;
  const ms = Date.parse(session.placed.payment.expiresAt) - Date.now();
  if (!(ms > 0)) return markExpired();
  const minutes = Math.floor(ms / 60000);
  const seconds = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  qs("#payment-expiry").textContent = `Pay within ${minutes}:${seconds} (by ${clockTime(session.placed.payment.expiresAt)}). After that the order is cancelled.`;
}

/** Catches payments confirmed elsewhere (Razorpay webhook) and orders the server expired. */
async function pollOrder() {
  if (!session) return;
  try {
    const summary = await api.getOrder(session.placed.orderId);
    if (!session) return;
    if (summary.status === "CANCELLED") markExpired();
    else if (summary.status !== UNPAID) settle(summary);
  } catch (_err) {
    // a missed poll changes nothing — the next one, or the customer's own action, catches up
  }
}

function stopTimers() {
  if (!session) return;
  clearInterval(session.countdown);
  clearInterval(session.poll);
}

function hideOverlay() {
  const overlay = qs("#payment-overlay");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  if (releaseFocusTrap) releaseFocusTrap();
  releaseFocusTrap = null;
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
}

/** The order left AWAITING_PAYMENT (paid): hand over to the tracker. */
function settle(summary) {
  if (!session || session.done) return;
  if (summary.status === UNPAID || summary.status === "CANCELLED") return;
  session.done = true;
  stopTimers();
  const { onPaid } = session;
  session = null;
  hideOverlay();
  if (document.activeElement) document.activeElement.blur();
  onPaid(summary);
}

function closePayment() {
  if (!session) return;
  const { placed, expired } = session;
  stopTimers();
  session = null;
  hideOverlay();
  if (!expired) {
    showToast(`Order ${placed.token} isn't confirmed until it's paid. Your cart is still saved.`);
  }
}

/**
 * Opens the payment step for a freshly placed order (the 201 body of
 * POST /api/checkout). `onPaid(summary)` runs once the order is paid.
 */
export function showPayment(placed, { onPaid }) {
  const pay = placed.payment;
  session = { placed, onPaid, expired: false, done: false };

  qs("#payment-token").textContent = placed.token;
  qs("#payment-amount").textContent = payAmount(pay);
  const expiry = qs("#payment-expiry");
  delete expiry.dataset.state;
  setError("");
  setHint(HINTS[pay.method] || "");

  const body = qs("#payment-body");
  body.innerHTML = pay.method === "razorpay" ? razorpayMarkup(pay) : demoMarkup();

  const overlay = qs("#payment-overlay");
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  releaseFocusTrap = trapFocus(overlay);
  overlay.querySelector(".sheet").scrollTop = 0;

  tickCountdown();
  session.countdown = setInterval(tickCountdown, 1000);
  session.poll = setInterval(pollOrder, 5000);

  const first = body.querySelector(".pay-main-btn");
  if (first) first.focus({ preventScroll: true });
  if (pay.method === "razorpay") openRazorpay();
}

export function initPayment() {
  const overlay = qs("#payment-overlay");
  if (!overlay) return;
  qs("#close-payment").addEventListener("click", closePayment);
  overlay.addEventListener("click", (e) => {
    if (!session) return;
    const target = e.target;
    if (target.closest("#rzp-pay-btn")) openRazorpay();
    else if (target.closest("#pay-check-btn")) checkRazorpay();
    else if (target.closest("#demo-pay-btn")) simulateDemo();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden && session) closePayment();
  });
}
