import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, qsa, showToast, trapFocus, setBackgroundInert } from "./utils.js";
import { addToCart } from "./state.js";
import { openAiGuideForProduct } from "./aiGuide.js";

let releaseFocusTrap = null;
let lastFocusedEl = null;
let currentProduct = null;
let selectedVariant = null;
let qty = 1;

function nutritionMarkup(product) {
  const n = product.nutrition || {};
  const hasAny = n.calories != null || n.protein != null || n.carbohydrates != null || n.fat != null || n.sugar != null;
  if (!hasAny) {
    return `<p>Nutrition information coming soon.</p>`;
  }
  const rows = [
    ["Calories", n.calories != null ? `${n.calories} kcal` : null],
    ["Protein", n.protein != null ? `${n.protein} g` : null],
    ["Carbohydrates", n.carbohydrates != null ? `${n.carbohydrates} g` : null],
    ["Fat", n.fat != null ? `${n.fat} g` : null],
    ["Sugar", n.sugar != null ? `${n.sugar} g` : null],
  ].filter(([, v]) => v);
  return `<ul>${rows.map(([label, v]) => `<li>${escapeHtml(label)}: ${escapeHtml(v)}</li>`).join("")}</ul>
    <p class="detail-note">Estimated nutrition — values may vary based on preparation, ingredients and serving size.</p>`;
}

function allergenMarkup(product) {
  if (!product.allergens || product.allergens.length === 0) {
    return `<p>We don't currently have confirmed allergen information for this item. Please contact DE.25 before ordering if you have an allergy.</p>`;
  }
  return `<p>${escapeHtml(product.allergens.join(", "))}</p>`;
}

function priceMarkup(product) {
  if (Array.isArray(product.variants) && product.variants.length) {
    return `<div class="variant-row" id="detail-variant-row">
      ${product.variants
        .map(
          (v, i) =>
            `<button type="button" class="variant-pill" data-variant="${escapeHtml(v.label)}" aria-pressed="${i === 0}">${escapeHtml(
              v.label
            )} — ${formatCurrency(v.price)}</button>`
        )
        .join("")}
    </div>`;
  }
  return `<p class="detail-price">${formatCurrency(product.price)}</p>`;
}

function render(product) {
  selectedVariant = Array.isArray(product.variants) && product.variants.length ? product.variants[0].label : null;
  qty = 1;

  // Only DE.25's real .jpg photos have a generated .webp sibling — an
  // illustrated/concept image (.svg, .png) is served as-is (see menu.js's
  // productImageMarkup for the same rule and why).
  const imageTag = product.image && /\.jpg$/i.test(product.image)
    ? `<picture>
        <source type="image/webp" srcset="${escapeHtml(product.image.replace(/\.jpg$/i, ".webp"))}">
        <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" width="600" height="450">
      </picture>`
    : product.image
      ? `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" width="600" height="450">`
      : null;

  // A photo can exist without being a real DE.25 photo — see
  // data/products.json's photoConfirmed/photoNote fields, used for the two
  // illustrated-concept cakes (Dark Chocolate Cake, Fruit Cake) that don't
  // have a real DE.25 photo yet. Never presented as if it were a real one.
  const photoDisclaimer =
    product.image && !product.photoConfirmed
      ? `<p class="detail-note image-note">${escapeHtml(
          product.photoNote || "Illustrated concept, not an actual DE.25 photo — a real product photo will replace this once DE.25 provides one."
        )}</p>`
      : "";

  const imageBlock = imageTag
    ? `<div class="detail-image">${imageTag}${photoDisclaimer}</div>`
    : `<div class="detail-image product-visual-fallback" role="img" aria-label="${escapeHtml(product.name)} — photo coming soon">
        <svg class="icon icon-lg" aria-hidden="true"><use href="#icon-sparkle"/></svg><span>Photo coming soon</span>
      </div>`;

  const body = qs("#product-detail-body");
  body.innerHTML = `
    <div class="detail-grid">
      ${imageBlock}
      <div>
        <h2 class="detail-name" id="product-title">${escapeHtml(product.name)}</h2>
        ${priceMarkup(product)}
        <p class="detail-desc">${escapeHtml(product.description)}</p>
        <p class="detail-note">Serving size: ${escapeHtml(product.servingSize || "—")}</p>

        <div class="detail-actions">
          <div class="qty-stepper" id="detail-qty-stepper">
            <button type="button" data-qty-dec aria-label="Decrease quantity"><svg class="icon" aria-hidden="true"><use href="#icon-minus"/></svg></button>
            <span id="detail-qty">1</span>
            <button type="button" data-qty-inc aria-label="Increase quantity"><svg class="icon" aria-hidden="true"><use href="#icon-plus"/></svg></button>
          </div>
        </div>
        <button type="button" class="primary-btn" id="detail-add-btn" ${!product.availability ? "disabled" : ""}>
          ${product.availability ? "Add to Cart" : "Currently unavailable"}
        </button>
        <button type="button" class="primary-btn secondary-btn" id="detail-ask-ai-btn">Ask the Food Guide about this</button>
      </div>
    </div>

    <div class="detail-section">
      <h3>Ingredients</h3>
      <p>${escapeHtml(product.ingredients.join(", "))}</p>
      ${!product.ingredientsConfirmed ? `<p class="detail-note">Read from the product photo/description — confirm with DE.25 if you have a specific concern.</p>` : ""}
    </div>
    <div class="detail-section">
      <h3>Allergen Information</h3>
      ${allergenMarkup(product)}
    </div>
    <div class="detail-section">
      <h3>Nutrition</h3>
      ${nutritionMarkup(product)}
    </div>
    ${!product.menuConfirmed ? `<div class="detail-section"><h3>Note</h3><p class="detail-note">${escapeHtml(product.priceNote || "Not on the current printed menu — price to be confirmed.")}</p></div>` : ""}
  `;

  qsa(".variant-pill", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedVariant = btn.dataset.variant;
      qsa(".variant-pill", body).forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    });
  });

  qs("[data-qty-dec]", body).addEventListener("click", () => updateQty(-1));
  qs("[data-qty-inc]", body).addEventListener("click", () => updateQty(1));
  qs("#detail-add-btn", body).addEventListener("click", () => {
    addToCart(product.productId, selectedVariant, qty);
    showToast(`${product.name} added to cart.`);
    closeProductDetail();
  });
  qs("#detail-ask-ai-btn", body).addEventListener("click", () => {
    closeProductDetail();
    openAiGuideForProduct(product);
  });
}

function updateQty(delta) {
  qty = Math.max(1, Math.min(20, qty + delta));
  const el = qs("#detail-qty");
  if (el) el.textContent = String(qty);
}

export async function openProductDetail(productId) {
  const overlay = qs("#product-overlay");
  lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  setBackgroundInert(true);

  qs("#product-detail-body").innerHTML = `<div class="skeleton-card" style="aspect-ratio:16/10;"></div>`;

  try {
    const { product } = await api.getProduct(productId);
    currentProduct = product;
    render(product);
  } catch (err) {
    qs("#product-detail-body").innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
  }

  releaseFocusTrap = trapFocus(overlay);
  qs("#close-product").focus();
}

export function closeProductDetail() {
  const overlay = qs("#product-overlay");
  overlay.classList.remove("is-open");
  document.body.style.overflow = "";
  setBackgroundInert(false);
  if (releaseFocusTrap) releaseFocusTrap();
  setTimeout(() => {
    overlay.hidden = true;
  }, 260);
  if (lastFocusedEl) lastFocusedEl.focus();
}

export function initProductDetail() {
  qs("#close-product").addEventListener("click", closeProductDetail);
  qs("#product-overlay").addEventListener("click", (e) => {
    if (e.target.id === "product-overlay") closeProductDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !qs("#product-overlay").hidden) closeProductDetail();
  });
}
