import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, trapFocus, showToast, setBackgroundInert } from "./utils.js";
import { getCart, clearCart } from "./state.js";
import { getLatestPricing } from "./cart.js";
import { closeCart } from "./cart.js";
import { showOrderStatus } from "./orderStatus.js";
import { createPhoneVerifier } from "./phoneVerify.js";

let releaseFocusTrap = null;
let lastFocusedEl = null;
let currentDeliveryQuote = null;
let phoneVerifier = null;

function setFieldError(id, message) {
  const el = qs(`#err-${id}`);
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

function validatePhone(value) {
  return /^\d{10}$/.test(value.trim());
}

function readAddress() {
  return {
    house: qs("#addr-house").value.trim(),
    street: qs("#addr-street").value.trim(),
    area: qs("#addr-area").value.trim(),
    city: qs("#addr-city").value.trim(),
    pincode: qs("#addr-pincode").value.trim(),
    landmark: qs("#addr-landmark").value.trim(),
  };
}

function updateTotalsDisplay() {
  const pricing = getLatestPricing();
  qs("#checkout-subtotal").textContent = formatCurrency(pricing ? pricing.subtotal : 0);
  const total = (pricing ? pricing.subtotal : 0) + (currentDeliveryQuote ? currentDeliveryQuote.feeRupees : 0);
  qs("#checkout-total").textContent = formatCurrency(total);
  qs("#checkout-delivery").textContent = currentDeliveryQuote ? formatCurrency(currentDeliveryQuote.feeRupees) : "—";
}

async function handleGetQuote() {
  const address = readAddress();
  const resultEl = qs("#delivery-quote-result");
  if (address.pincode.length !== 6 || !/^\d{6}$/.test(address.pincode)) {
    resultEl.hidden = false;
    resultEl.innerHTML = `<span class="qr-tag">Missing info</span>Please enter a valid 6-digit pincode first.`;
    return;
  }
  if (!address.house || !address.street || !address.area || !address.city) {
    resultEl.hidden = false;
    resultEl.innerHTML = `<span class="qr-tag">Missing info</span>Please fill in your full address first.`;
    return;
  }
  resultEl.hidden = false;
  resultEl.innerHTML = `<span class="qr-tag">Checking…</span>Getting a delivery estimate…`;
  try {
    const quote = await api.getDeliveryQuote(address);
    currentDeliveryQuote = quote;
    const tag = quote.isLive ? "Live Borzo estimate" : "Demo delivery estimate";
    resultEl.innerHTML = `<span class="qr-tag">${escapeHtml(tag)}</span>Delivery fee: <strong>${formatCurrency(
      quote.feeRupees
    )}</strong> · Estimated arrival: <strong>~${escapeHtml(String(quote.etaMinutes))} min</strong> after pickup${
      quote.isLive ? "" : "<br><span style=\"color:var(--muted);font-size:11.5px;\">Borzo delivery isn't connected yet — this is a placeholder estimate for the demo.</span>"
    }`;
    updateTotalsDisplay();
  } catch (err) {
    resultEl.innerHTML = `<span class="qr-tag">Error</span>${escapeHtml(err.message)}`;
  }
}

function validateForm() {
  let valid = true;
  const name = qs("#cust-name").value.trim();
  const phone = qs("#cust-phone").value.trim();
  const email = qs("#cust-email").value.trim();

  setFieldError("cust-name", "");
  setFieldError("cust-phone", "");
  setFieldError("cust-email", "");
  setFieldError("address", "");

  if (!name) {
    setFieldError("cust-name", "Please enter your name.");
    valid = false;
  } else if (name.split(/\s+/).filter((w) => w.replace(/[^\p{L}]/gu, "").length > 0).length < 2) {
    // Name + surname, so the owner can tell orders apart on the dashboard.
    setFieldError("cust-name", "Please enter your first name and surname.");
    valid = false;
  }
  if (!validatePhone(phone)) {
    setFieldError("cust-phone", "Please enter a 10-digit WhatsApp number.");
    valid = false;
  } else if (!phoneVerifier.isVerified()) {
    setFieldError(
      "cust-phone",
      phoneVerifier.isCodeStep()
        ? "Please enter the 6-digit code we sent on WhatsApp and tap Verify."
        : "Please tap “Send code” and confirm your WhatsApp number."
    );
    valid = false;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setFieldError("cust-email", "Please enter a valid email address.");
    valid = false;
  }
  const address = readAddress();
  if (!address.house || !address.street || !address.area || !address.city || !/^\d{6}$/.test(address.pincode)) {
    setFieldError("address", "Please fill in your complete delivery address, including a 6-digit pincode.");
    valid = false;
  }
  return valid;
}

async function handleSubmit(e) {
  e.preventDefault();
  const formError = qs("#checkout-form-error");
  formError.hidden = true;

  if (!validateForm()) {
    const firstError = qs("#checkout-form .field-error:not([hidden])");
    if (firstError) firstError.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }

  const items = getCart();
  if (items.length === 0) {
    formError.hidden = false;
    formError.textContent = "Your cart is empty.";
    return;
  }

  const payload = {
    customer: {
      name: qs("#cust-name").value.trim(),
      phone: qs("#cust-phone").value.trim(),
      email: qs("#cust-email").value.trim() || undefined,
    },
    address: readAddress(),
    items,
    deliveryOption: "home-delivery",
    paymentMethod: qs('input[name="paymentMethod"]:checked').value,
    phoneVerificationToken: phoneVerifier.getToken(),
  };

  const submitBtn = qs("#place-order-btn");
  const submitLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving your order…";

  try {
    const order = await api.checkout(payload);
    // The order is saved (awaiting payment) — the cart can go; if payment
    // fails, the customer retries from the order screen, not by re-ordering.
    clearCart();
    currentDeliveryQuote = null;
    closeCheckout();
    showOrderStatus(order, { checkout: order.checkout });
  } catch (err) {
    if (err.data && err.data.needsVerification) {
      phoneVerifier.reset();
      setFieldError("cust-phone", err.message);
    } else {
      formError.hidden = false;
      formError.textContent = err.message;
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
  }
}

export function openCheckout() {
  closeCart();
  currentDeliveryQuote = null;
  qs("#delivery-quote-result").hidden = true;
  updateTotalsDisplay();
  const overlay = qs("#checkout-drawer");
  lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  releaseFocusTrap = trapFocus(overlay);
  if (phoneVerifier) phoneVerifier.refresh();
  qs("#cust-name").focus();
}

export function closeCheckout() {
  const overlay = qs("#checkout-drawer");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  if (releaseFocusTrap) releaseFocusTrap();
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
  if (lastFocusedEl) lastFocusedEl.focus();
}

export function initCheckout() {
  qs("#to-checkout-btn").addEventListener("click", openCheckout);
  qs("#close-checkout").addEventListener("click", closeCheckout);
  qs("#checkout-drawer").addEventListener("click", (e) => {
    if (e.target.id === "checkout-drawer") closeCheckout();
  });
  qs("#get-delivery-quote-btn").addEventListener("click", handleGetQuote);
  qs("#checkout-form").addEventListener("submit", handleSubmit);
  phoneVerifier = createPhoneVerifier({
    phoneInput: qs("#cust-phone"),
    sendBtn: qs("#cust-phone-send"),
    codeWrap: qs("#cust-phone-code-wrap"),
    codeInput: qs("#cust-phone-code"),
    confirmBtn: qs("#cust-phone-confirm"),
    statusEl: qs("#cust-phone-status"),
    errorEl: qs("#err-cust-phone"),
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !qs("#checkout-drawer").hidden) closeCheckout();
  });
}
