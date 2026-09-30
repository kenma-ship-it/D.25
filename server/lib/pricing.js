/**
 * Server-side pricing. This is the ONLY place order totals are calculated.
 *
 * The frontend cart shows an optimistic running total for responsiveness,
 * but that number is never trusted — every price shown at checkout and
 * every total actually charged/recorded comes from priceCart() here, which
 * re-reads each product from the datastore by id and ignores any price,
 * name or line-total the client sent. This is what stops a manipulated
 * request body (edited productPrice, negative quantity, a discount field
 * invented client-side, a delivery fee copied from a different address)
 * from ever reaching an order total.
 */
const { getProductById } = require("./datastore");

const MAX_QTY_PER_LINE = 20;
const MAX_LINES = 30;

class PricingError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "PricingError";
    this.field = field;
    this.statusCode = 400;
  }
}

/**
 * @param {Array<{productId:string, qty:number, variantLabel?:string}>} items
 *   Untrusted, client-supplied cart lines — only productId/qty/variantLabel
 *   are read from each; any other field (price, name, subtotal, ...) is
 *   ignored on purpose.
 * @param {{feeRupees:number, etaMinutes:number, provider:string} | null} deliveryQuote
 *   A quote object produced by the delivery service (never client-supplied).
 */
function priceCart(items, deliveryQuote) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PricingError("Cart is empty.", "items");
  }
  if (items.length > MAX_LINES) {
    throw new PricingError("Too many distinct items in one order.", "items");
  }

  const lines = items.map((rawLine, index) => {
    if (!rawLine || typeof rawLine.productId !== "string") {
      throw new PricingError(`Line ${index + 1} is missing a productId.`, "items");
    }
    const qty = Number(rawLine.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw new PricingError(`Line ${index + 1} has an invalid quantity.`, "items");
    }
    const product = getProductById(rawLine.productId);
    if (!product) {
      throw new PricingError(`One of the items in your cart is no longer on the menu.`, "items");
    }
    if (!product.availability) {
      throw new PricingError(`"${product.name}" is currently unavailable.`, "items");
    }

    let unitPrice = product.price;
    let variantLabel = null;
    if (Array.isArray(product.variants) && product.variants.length > 0) {
      const requested = typeof rawLine.variantLabel === "string" ? rawLine.variantLabel : product.variants[0].label;
      const variant = product.variants.find((v) => v.label === requested);
      if (!variant) {
        throw new PricingError(`"${requested}" is not a valid option for "${product.name}".`, "items");
      }
      unitPrice = variant.price;
      variantLabel = variant.label;
    }

    return {
      productId: product.productId,
      name: product.name,
      variantLabel,
      unitPrice,
      qty,
      lineTotal: unitPrice * qty,
    };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const deliveryFee = deliveryQuote ? Math.max(0, Math.round(deliveryQuote.feeRupees)) : 0;
  const tax = 0; // DE.25 has not confirmed a tax registration/rate — never invent one.
  const total = subtotal + deliveryFee + tax;

  return { lines, subtotal, deliveryFee, tax, total, deliveryQuote: deliveryQuote || null };
}

module.exports = { priceCart, PricingError, MAX_QTY_PER_LINE, MAX_LINES };
