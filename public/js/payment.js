/**
 * Opens the payment window for an order and reports what happened.
 *
 *   payForOrder(orderId, checkout) -> Promise<{ result, order? }>
 *     result: "checked"   server has the outcome (order.payment says paid or failed)
 *             "pending"   paid at the gateway but not confirmed yet (network drop,
 *                         slow gateway) — the order screen keeps checking; the
 *                         webhook / reconcile on the server confirms it
 *             "dismissed" customer closed the window without paying
 *
 * The browser never decides an order is paid: Razorpay's result goes to
 * the server, which checks its signature and asks Razorpay directly.
 */
import { api } from "./api.js";
import { formatCurrency, trapFocus } from "./utils.js";

let razorpayLoading = null;
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (!razorpayLoading) {
    razorpayLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = resolve;
      s.onerror = () => {
        razorpayLoading = null;
        reject(new Error("Couldn't open the payment window. Please check your connection and try again."));
      };
      document.head.appendChild(s);
    });
  }
  return razorpayLoading;
}

async function payWithRazorpay(orderId, c) {
  await loadRazorpay();
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const rzp = new window.Razorpay({
      key: c.keyId,
      order_id: c.gatewayOrderId,
      amount: c.amountPaise,
      currency: c.currency,
      name: c.name,
      description: c.description,
      prefill: c.prefill,
      notes: c.notes,
      theme: { color: "#0d0c0b" },
      modal: { confirm_close: true, ondismiss: () => done({ result: "dismissed" }) },
      handler: async (resp) => {
        try {
          const r = await api.verifyPayment(orderId, resp);
          done({ result: r.pending ? "pending" : "checked", order: r.order });
        } catch (_e) {
          // Money may well have been taken — never tell the customer it failed
          // here. The order screen keeps checking until the server confirms.
          done({ result: "pending" });
        }
      },
    });
    rzp.on("payment.failed", (r) => {
      const e = (r && r.error) || {};
      api
        .reportPaymentFailure(orderId, { paymentId: e.metadata && e.metadata.payment_id, code: e.code, reason: e.description })
        .catch(() => {});
      // Razorpay keeps its window open so the customer can try another method.
    });
    rzp.open();
  });
}

/** Demo sheet: no gateway connected yet, so the customer (or a tester) picks the outcome. */
function payDemo(orderId, c) {
  return new Promise((resolve) => {
    const amount = formatCurrency(c.amountPaise / 100);
    const wrap = document.createElement("div");
    wrap.className = "overlay demo-pay";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "demo-pay-title");
    wrap.innerHTML = `
      <div class="sheet demo-pay-sheet">
        <p class="demo-pay-kicker">Demo payment</p>
        <h2 id="demo-pay-title">Pay ${amount}</h2>
        <p class="demo-pay-note">Online payment isn't connected yet, so no money is taken. Choose what happens to test the order flow.</p>
        <button type="button" class="primary-btn" data-outcome="success">Pay ${amount} (demo)</button>
        <button type="button" class="primary-btn secondary-btn" data-outcome="failure">Simulate a failed payment</button>
        <button type="button" class="demo-pay-cancel" data-outcome="cancel">Close without paying</button>
        <p class="field-error" data-error hidden></p>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-open"));
    const release = trapFocus(wrap);
    wrap.querySelector('[data-outcome="success"]').focus();

    const close = (value) => {
      release();
      wrap.classList.remove("is-open");
      setTimeout(() => wrap.remove(), 260);
      resolve(value);
    };
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close({ result: "dismissed" });
    });
    wrap.querySelectorAll("[data-outcome]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const outcome = btn.dataset.outcome;
        if (outcome === "cancel") return close({ result: "dismissed" });
        wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          const r = await api.demoPay(orderId, outcome);
          close({ result: "checked", order: r.order });
        } catch (e) {
          const err = wrap.querySelector("[data-error]");
          err.textContent = e.message;
          err.hidden = false;
          wrap.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      })
    );
  });
}

export async function payForOrder(orderId, checkout) {
  if (!checkout) return { result: "dismissed" };
  if (checkout.provider === "razorpay") return payWithRazorpay(orderId, checkout);
  return payDemo(orderId, checkout);
}
