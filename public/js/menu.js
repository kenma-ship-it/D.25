import { api } from "./api.js";
import { escapeHtml, formatCurrency, qs, qsa, showToast } from "./utils.js";
import { observeNewReveals } from "./animations.js";
import { addToCart } from "./state.js";
import { openProductDetail } from "./productDetail.js";

let allProducts = [];
let currentFilter = "all";

function fallbackVisualMarkup(name) {
  return `<div class="product-visual-fallback" role="img" aria-label="${escapeHtml(name)} — photo coming soon">
    <svg class="icon icon-lg" aria-hidden="true"><use href="#icon-sparkle"/></svg>
    <span>Photo coming soon</span>
  </div>`;
}

function productImageMarkup(product) {
  if (!product.image) return fallbackVisualMarkup(product.name);
  // Only DE.25's real .jpg photos have a generated .webp sibling (see
  // scripts/generate-webp or similar at build time). Illustrated/concept
  // images (.svg, .png) are served as-is — pointing a <source
  // type="image/webp"> at a file that isn't actually webp would make some
  // browsers skip the real image entirely.
  if (!/\.jpg$/i.test(product.image)) {
    return `<img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" width="400" height="300">`;
  }
  const webp = product.image.replace(/\.jpg$/i, ".webp");
  return `<picture>
    <source type="image/webp" srcset="${escapeHtml(webp)}">
    <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async" width="400" height="300">
  </picture>`;
}

/** Wires a graceful fallback for any product photo that fails to load — never a broken-image icon. */
function wireImageFallbacks(container) {
  qsa(".product-visual img", container).forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        const visual = img.closest(".product-visual");
        const name = visual.closest(".product-card")?.querySelector(".product-name")?.textContent || "";
        const picture = img.closest("picture");
        if (picture) picture.remove();
        visual.insertAdjacentHTML("beforeend", fallbackVisualMarkup(name));
      },
      { once: true }
    );
  });
}

function priceLabel(product) {
  if (Array.isArray(product.variants) && product.variants.length) {
    const prices = product.variants.map((v) => v.price);
    return `From ${formatCurrency(Math.min(...prices))}`;
  }
  return formatCurrency(product.price);
}

function productCardMarkup(product) {
  const tags = (product.dietaryTags || []).map((t) => `<span class="product-tag">${escapeHtml(t)}</span>`).join("");
  const flag = !product.menuConfirmed ? `<span class="product-flag">New</span>` : "";
  const badge = product.featured ? `<span class="product-badge">Bestseller</span>` : "";
  // Distinct from menuConfirmed (name/price) — this flags an illustrated
  // concept image standing in for a real DE.25 photo. Placed in the
  // opposite corner from the "New" flag so both can show at once without
  // overlapping.
  const photoFlag = product.image && !product.photoConfirmed ? `<span class="product-flag photo-flag">Concept image</span>` : "";
  return `
    <article class="product-card" data-reveal data-product-id="${escapeHtml(product.productId)}">
      <div class="product-visual" data-open-detail>
        ${badge}${flag}${photoFlag}
        ${productImageMarkup(product)}
      </div>
      <div class="product-body">
        <div class="product-name-row">
          <h3 class="product-name" data-open-detail>${escapeHtml(product.name)}</h3>
          <span class="product-price">${priceLabel(product)}</span>
        </div>
        <p class="product-desc">${escapeHtml(product.description)}</p>
        ${tags ? `<div class="product-tags">${tags}</div>` : ""}
        <div class="product-foot">
          <button type="button" class="ghost-link" data-open-detail>View <svg class="icon" aria-hidden="true"><use href="#icon-chevron"/></svg></button>
          <button type="button" class="add-btn" data-quick-add ${!product.availability ? "disabled" : ""}>${
    product.availability ? "Add" : "Unavailable"
  }</button>
        </div>
      </div>
    </article>
  `;
}

function render() {
  const grid = qs("#menu-grid");
  const empty = qs("#menu-empty");
  const filtered =
    currentFilter === "all"
      ? allProducts
      : Array.isArray(currentFilter)
      ? allProducts.filter((p) => currentFilter.includes(p.category))
      : allProducts.filter((p) => p.category === currentFilter);

  grid.setAttribute("aria-busy", "false");
  if (filtered.length === 0) {
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.innerHTML = filtered.map(productCardMarkup).join("");
  observeNewReveals(grid);
  wireImageFallbacks(grid);

  qsa("[data-open-detail]", grid).forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.closest(".product-card").dataset.productId;
      openProductDetail(id);
    });
  });
  qsa("[data-quick-add]", grid).forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".product-card");
      const id = card.dataset.productId;
      const product = allProducts.find((p) => p.productId === id);
      if (!product) return;
      if (Array.isArray(product.variants) && product.variants.length > 1) {
        openProductDetail(id);
        return;
      }
      const variantLabel = Array.isArray(product.variants) && product.variants.length === 1 ? product.variants[0].label : null;
      addToCart(id, variantLabel, 1);
      showToast(`${product.name} added to cart.`);
    });
  });
}

function setActiveFilter(category) {
  currentFilter = category;
  qsa(".filter-chip").forEach((chip) => {
    const active = chip.dataset.category === category;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-selected", String(active));
  });
  render();
}

export function initMenu() {
  // The homepage has no grid any more (its menu is the cinematic card stack,
  // js/cinematicMenu.js); only the category pages render one.
  if (!document.getElementById("menu-grid")) return;

  // A page can lock the grid to one or more categories (see public/cakes.html,
  // pastries.html, savouries.html, sips.html) by setting data-category-lock
  // on <body> — used for dedicated category pages that don't need the
  // "All / Cakes / Pastries / ..." filter chips at all. Comma-separate
  // multiple category ids (e.g. "savouries,sips") to combine them into one grid.
  const lock = document.body.dataset.categoryLock;
  if (lock) currentFilter = lock.includes(",") ? lock.split(",").map((s) => s.trim()) : lock;

  qsa(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => setActiveFilter(chip.dataset.category));
  });
  qsa("[data-filter]").forEach((link) => {
    link.addEventListener("click", () => setActiveFilter(link.dataset.filter));
  });

  api
    .getProducts()
    .then(({ products }) => {
      allProducts = products;
      render();
    })
    .catch(() => {
      qs("#menu-grid").innerHTML = "";
      qs("#menu-error").hidden = false;
    });
}

export function getAllProducts() {
  return allProducts;
}
