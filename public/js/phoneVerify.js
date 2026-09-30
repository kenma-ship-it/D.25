/**
 * WhatsApp number verification — shared by checkout and "My Orders".
 *
 * A customer proves a phone number is theirs by typing back the 6-digit
 * code DE.25 sends to it on WhatsApp. The server then issues a short-lived
 * token (30 min) that checkout and My Orders send along. The token is kept
 * in sessionStorage so verifying once — say at checkout — also unlocks
 * My Orders for the rest of that visit without a second code.
 */
import { api } from "./api.js";

const STORAGE_KEY = "de25.phoneVerification";

function readStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.expiresAt > Date.now()) return parsed;
  } catch (_err) {
    /* storage unavailable (private mode etc.) — just means no reuse */
  }
  return null;
}

/** A still-valid token for exactly this phone, or null. */
export function getStoredToken(phone) {
  const stored = readStored();
  return stored && stored.phone === phone ? stored.token : null;
}

function store(phone, token, expiresInSeconds) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phone, token, expiresAt: Date.now() + expiresInSeconds * 1000 - 15000 }));
  } catch (_err) {
    /* ignore */
  }
}

export function clearStoredToken() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (_err) {
    /* ignore */
  }
}

const maskPhone = (p) => `${p.slice(0, 2)}••••••${p.slice(-2)}`;

/**
 * Wires one verification widget. Elements (all required):
 *   phoneInput, sendBtn, codeWrap, codeInput, confirmBtn, statusEl, errorEl
 * Callbacks: onVerified(token), onReset()
 * Returns { isVerified(), getToken(), send(), confirm(), reset() }.
 */
export function createPhoneVerifier(els, { onVerified = () => {}, onReset = () => {}, enterConfirms = true } = {}) {
  const { phoneInput, sendBtn, codeWrap, codeInput, confirmBtn, statusEl, errorEl } = els;
  let token = null;
  let verifiedPhone = null;
  let cooldownTimer = null;
  const sendLabel = sendBtn.textContent;

  const phone = () => phoneInput.value.replace(/\D/g, "").slice(0, 10);
  const setError = (msg) => {
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  };
  const setStatus = (msg, state = "") => {
    statusEl.textContent = msg || "";
    statusEl.dataset.state = state;
  };

  function startCooldown(seconds) {
    clearInterval(cooldownTimer);
    let left = seconds;
    sendBtn.disabled = true;
    sendBtn.textContent = `Resend in ${left}s`;
    cooldownTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(cooldownTimer);
        sendBtn.disabled = false;
        sendBtn.textContent = "Resend code";
        return;
      }
      sendBtn.textContent = `Resend in ${left}s`;
    }, 1000);
  }

  function markVerified(t, p) {
    token = t;
    verifiedPhone = p;
    codeWrap.hidden = true;
    codeInput.value = "";
    clearInterval(cooldownTimer);
    sendBtn.hidden = true;
    setError("");
    setStatus(`WhatsApp number verified`, "verified");
    onVerified(t);
  }

  function reset() {
    const wasVerified = Boolean(token);
    token = null;
    verifiedPhone = null;
    codeWrap.hidden = true;
    codeInput.value = "";
    clearInterval(cooldownTimer);
    sendBtn.hidden = false;
    sendBtn.disabled = false;
    sendBtn.textContent = sendLabel;
    setStatus("");
    if (wasVerified) onReset();
  }

  function restoreIfStored() {
    const p = phone();
    const stored = p.length === 10 ? getStoredToken(p) : null;
    if (stored) markVerified(stored, p);
  }

  async function send() {
    setError("");
    const p = phone();
    if (!/^\d{10}$/.test(p)) {
      setError("Please enter a 10-digit mobile number first.");
      phoneInput.focus();
      return false;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    try {
      const res = await api.requestPhoneCode(p);
      codeWrap.hidden = false;
      const demo = res.demoCode
        ? ` Demo mode (no WhatsApp account connected yet): your code is ${res.demoCode}.`
        : "";
      setStatus(`Code sent on WhatsApp to ${maskPhone(p)}. It expires in ${Math.round(res.expiresInSeconds / 60)} minutes.${demo}`, "sent");
      startCooldown(res.resendInSeconds || 30);
      codeInput.focus();
      return true;
    } catch (err) {
      sendBtn.disabled = false;
      sendBtn.textContent = sendLabel;
      if (err.data && err.data.retryAfterSeconds) startCooldown(err.data.retryAfterSeconds);
      setError(err.message);
      return false;
    }
  }

  async function confirm() {
    setError("");
    const p = phone();
    const code = codeInput.value.replace(/\D/g, "");
    if (code.length !== 6) {
      setError("Please enter the 6-digit code from WhatsApp.");
      codeInput.focus();
      return false;
    }
    confirmBtn.disabled = true;
    try {
      const res = await api.confirmPhoneCode(p, code);
      store(p, res.verificationToken, res.expiresInSeconds);
      markVerified(res.verificationToken, p);
      return true;
    } catch (err) {
      setError(err.message);
      if (err.status === 410 || err.status === 429) {
        codeWrap.hidden = true;
        codeInput.value = "";
      } else {
        codeInput.select();
      }
      return false;
    } finally {
      confirmBtn.disabled = false;
    }
  }

  // Changing the number after verifying invalidates the verification.
  phoneInput.addEventListener("input", () => {
    if (verifiedPhone && phone() !== verifiedPhone) reset();
    else if (!token) restoreIfStored();
  });
  sendBtn.addEventListener("click", send);
  confirmBtn.addEventListener("click", confirm);
  codeInput.addEventListener("keydown", (e) => {
    if (enterConfirms && e.key === "Enter") {
      e.preventDefault();
      confirm();
    }
  });

  return {
    isVerified: () => Boolean(token) && phone() === verifiedPhone,
    getToken: () => token,
    send,
    confirm,
    reset: () => {
      clearStoredToken();
      reset();
    },
    refresh: restoreIfStored,
    isCodeStep: () => !codeWrap.hidden,
  };
}
