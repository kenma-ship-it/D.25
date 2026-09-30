/**
 * Cart state — held in memory and mirrored to localStorage so a refresh
 * doesn't wipe out someone's cart mid-order. This is a real website the
 * customer runs in their own browser (not an in-app preview), so
 * localStorage is the right tool here; every read/write is wrapped in
 * try/catch since storage can be unavailable (private browsing, storage
 * full, disabled by a policy) and the cart must keep working in memory
 * even then.
 *
 * IMPORTANT: this cart is for UI convenience only. The actual prices shown
 * come from the server (see js/api.js priceCart / checkout) — this module
 * never invents or trusts a price of its own.
 */
const STORAGE_KEY = "de25_cart_v1";

let cart = loadCart();
const listeners = new Set();

function loadCart() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((l) => l && typeof l.productId === "string" && Number.isInteger(l.qty) && l.qty > 0);
  } catch (_e) {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  } catch (_e) {
    // storage unavailable — the cart still works for this page view, it just won't survive a refresh.
  }
}

function notify() {
  listeners.forEach((fn) => fn(getCart()));
}

export function getCart() {
  return cart.slice();
}

export function onCartChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lineKey(productId, variantLabel) {
  return `${productId}::${variantLabel || ""}`;
}

export function addToCart(productId, variantLabel, qty = 1) {
  const key = lineKey(productId, variantLabel);
  const existing = cart.find((l) => lineKey(l.productId, l.variantLabel) === key);
  if (existing) {
    existing.qty = Math.min(20, existing.qty + qty);
  } else {
    cart.push({ productId, variantLabel: variantLabel || null, qty: Math.min(20, qty) });
  }
  persist();
  notify();
}

export function setQty(productId, variantLabel, qty) {
  const key = lineKey(productId, variantLabel);
  if (qty <= 0) {
    cart = cart.filter((l) => lineKey(l.productId, l.variantLabel) !== key);
  } else {
    const line = cart.find((l) => lineKey(l.productId, l.variantLabel) === key);
    if (line) line.qty = Math.min(20, qty);
  }
  persist();
  notify();
}

export function removeFromCart(productId, variantLabel) {
  setQty(productId, variantLabel, 0);
}

export function clearCart() {
  cart = [];
  persist();
  notify();
}

export function cartItemCount() {
  return cart.reduce((sum, l) => sum + l.qty, 0);
}
