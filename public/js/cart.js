import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, qsa, trapFocus, setBackgroundInert } from "./utils.js";
import { getCart, setQty, removeFromCart, onCartChange, cartItemCount } from "./state.js";
import { getAllProducts } from "./menu.js";

let releaseFocusTrap = null;
let lastFocusedEl = null;
let latestPricing = null;

export function getLatestPricing() {
  return latestPricing;
}

function findImage(productId) {
  const p = getAllProducts().find((x) => x.productId === productId);
  return p ? p.image : null;
}

async function refreshPricing() {
  const items = getCart();
  const totalsBlock = qs("#cart-totals");
  const linesWrap = qs("#cart-lines");
  const emptyState = qs("#cart-empty");
  const checkoutBtn = qs("#to-checkout-btn");

  if (items.length === 0) {
    latestPricing = null;
    linesWrap.innerHTML = "";
    emptyState.hidden = false;
    totalsBlock.hidden = true;
    checkoutBtn.disabled = true;
    return;
  }
  emptyState.hidden = true;

  try {
    const pricing = await api.priceCart(items);
    latestPricing = pricing;
    linesWrap.innerHTML = pricing.lines
      .map((line) => {
        const image = findImage(line.productId);
        const imgTag = image
          ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" width="64" height="64">`
          : `<div style="width:64px;height:64px;border-radius:8px;background:var(--ivory);"></div>`;
        return `
          <div class="cart-line" data-product-id="${escapeHtml(line.productId)}" data-variant="${escapeHtml(line.variantLabel || "")}">
            ${imgTag}
            <div class="cart-line-info">
              <div class="cart-line-name">${escapeHtml(line.name)}</div>
              ${line.variantLabel ? `<div class="cart-line-variant">${escapeHtml(line.variantLabel)}</div>` : ""}
              <div class="qty-stepper">
                <button type="button" data-dec aria-label="Decrease quantity"><svg class="icon" aria-hidden="true"><use href="#icon-minus"/></svg></button>
                <span>${line.qty}</span>
                <button type="button" data-inc aria-label="Increase quantity"><svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg></button>
              </div>
            </div>
            <div class="cart-line-right">
              <div>${formatCurrency(line.lineTotal)}</div>
              <button type="button" class="remove-link" data-remove>Remove</button>
            </div>
          </div>`;
      })
      .join("");

    qsa("[data-dec]", linesWrap).forEach((btn) =>
      btn.addEventListener("click", () => {
        const line = btn.closest(".cart-line");
        const current = pricing.lines.find((l) => l.productId === line.dataset.productId && (l.variantLabel || "") === line.dataset.variant);
        setQty(line.dataset.productId, line.dataset.variant || null, (current?.qty || 1) - 1);
      })
    );
    qsa("[data-inc]", linesWrap).forEach((btn) =>
      btn.addEventListener("click", () => {
        const line = btn.closest(".cart-line");
        const current = pricing.lines.find((l) => l.productId === line.dataset.productId && (l.variantLabel || "") === line.dataset.variant);
        setQty(line.dataset.productId, line.dataset.variant || null, (current?.qty || 0) + 1);
      })
    );
    qsa("[data-remove]", linesWrap).forEach((btn) =>
      btn.addEventListener("click", () => {
        const line = btn.closest(".cart-line");
        removeFromCart(line.dataset.productId, line.dataset.variant || null);
      })
    );

    qs("#cart-subtotal").textContent = formatCurrency(pricing.subtotal);
    totalsBlock.hidden = false;
    checkoutBtn.disabled = false;
  } catch (err) {
    linesWrap.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
    totalsBlock.hidden = true;
    checkoutBtn.disabled = true;
  }
}

function updateCartCount() {
  qs("#cart-count").textContent = String(cartItemCount());
}

export function openCart() {
  const overlay = qs("#cart-drawer");
  lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);
  releaseFocusTrap = trapFocus(overlay);
  refreshPricing();
  qs("#close-cart").focus();
}

export function closeCart() {
  const overlay = qs("#cart-drawer");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  if (releaseFocusTrap) releaseFocusTrap();
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
  if (lastFocusedEl) lastFocusedEl.focus();
}

export function initCart() {
  updateCartCount();
  onCartChange(() => {
    updateCartCount();
    if (!qs("#cart-drawer").hidden) refreshPricing();
  });
  qs("#open-cart-btn").addEventListener("click", openCart);
  qs("#close-cart").addEventListener("click", closeCart);
  qs("#cart-drawer").addEventListener("click", (e) => {
    if (e.target.id === "cart-drawer") closeCart();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !qs("#cart-drawer").hidden) closeCart();
  });
}
