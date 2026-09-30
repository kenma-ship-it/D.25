/**
 * DE.25 Food Guide — a constrained, deterministic Q&A engine.
 *
 * This intentionally does NOT call a general-purpose LLM. The brief is
 * explicit and the stakes are real: a wrong "no nuts" answer from a
 * hallucinating model is a genuine safety problem, not a demo nitpick. So
 * instead this module only ever composes its answers from fields already
 * present in data/products.json — it cannot say anything the datastore
 * doesn't already contain, by construction rather than by prompting. If a
 * more conversational layer is wanted later, the safe way to add one is a
 * phrasing-only LLM pass that receives exactly the facts object this
 * module already retrieves and is forbidden from adding anything beyond
 * them — this module's retrieveFacts() already produces that object, so
 * that enhancement can be bolted on without touching the retrieval logic.
 */
const { getAllProducts, getProductsByCategory, getCategories } = require("../lib/datastore");

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, a: 1, an: 1 };

function findServingMultiplier(message) {
  const digitMatch = message.match(/(\d+)\s*(servings?|pieces?|cups?|glasses?|jars?|boxes?)/i);
  if (digitMatch) return Math.max(1, Math.min(20, parseInt(digitMatch[1], 10)));
  const wordMatch = message.match(/\b(one|two|three|four|five|six|a|an)\b\s*(servings?|pieces?|cups?|glasses?)/i);
  if (wordMatch) return NUMBER_WORDS[wordMatch[1].toLowerCase()] || 1;
  if (/\bdouble\b/i.test(message)) return 2;
  return 1;
}

function findMentionedProduct(message, products) {
  const lower = message.toLowerCase();
  // Longest-name-first so "Nutella Cheesecake" isn't shadowed by "Cheesecake".
  const sorted = [...products].sort((a, b) => b.name.length - a.name.length);
  return sorted.find((p) => lower.includes(p.name.toLowerCase())) || null;
}

function findMentionedCategory(message, categories) {
  const lower = message.toLowerCase();
  return categories.find((c) => lower.includes(c.id) || lower.includes(c.label.toLowerCase())) || null;
}

const INTENTS = {
  nutrition: /\b(calories?|kcal|nutrition(al)?|proteins?|carbs?|carbohydrates?|fats?|sugars?)\b/i,
  ingredients: /\b(ingredients?|made of|what'?s in|contains?\b(?! nuts| dairy| egg| gluten))/i,
  allergen: /\b(allerg|contains? (nuts|dairy|egg|gluten)|gluten.?free|nut.?free|dairy.?free|vegan|vegetarian|eggless)/i,
  price: /\b(price|cost|how much)\b/i,
  browseCategory: /\b(show me|list|what.*(do you have|is available)|which)\b/i,
};

/** Pure retrieval: returns a JSON-serializable "facts" object with no prose. */
function retrieveFacts(message, productIdHint) {
  const products = getAllProducts();
  const categories = getCategories();
  const product = (productIdHint && products.find((p) => p.productId === productIdHint)) || findMentionedProduct(message, products);
  const category = findMentionedCategory(message, categories);
  const multiplier = findServingMultiplier(message);

  const chocolateProducts = products.filter((p) =>
    p.ingredients.some((i) => /chocolate|cocoa|nutella/i.test(i)) || /chocolate/i.test(p.name)
  );

  return { product, category, multiplier, products, categories, chocolateProducts };
}

function describeIngredients(product) {
  const list = product.ingredients.join(", ");
  const caveat = product.ingredientsConfirmed
    ? ""
    : " (read from the product photo/description — confirm with DE.25 if you have a specific concern)";
  return `${product.name} is made with: ${list}.${caveat}`;
}

function describeAllergens(product) {
  if (!product.allergens || product.allergens.length === 0) {
    return "We don't currently have confirmed allergen information for this item. Please contact DE.25 before ordering if you have an allergy.";
  }
  return `Confirmed allergens for ${product.name}: ${product.allergens.join(", ")}.`;
}

function describeNutrition(product, multiplier) {
  const n = product.nutrition || {};
  const hasAny = n.calories != null || n.protein != null || n.carbohydrates != null || n.fat != null || n.sugar != null;
  if (!hasAny) {
    return `Nutrition information coming soon for ${product.name} — DE.25 hasn't provided confirmed nutrition figures for this item yet, so I won't estimate one.`;
  }
  const scale = (v) => (v == null ? null : Math.round(v * multiplier));
  const parts = [];
  if (n.calories != null) parts.push(`${scale(n.calories)} kcal`);
  if (n.protein != null) parts.push(`${scale(n.protein)}g protein`);
  if (n.carbohydrates != null) parts.push(`${scale(n.carbohydrates)}g carbohydrates`);
  if (n.fat != null) parts.push(`${scale(n.fat)}g fat`);
  if (n.sugar != null) parts.push(`${scale(n.sugar)}g sugar`);
  const servingWord = multiplier === 1 ? "1 serving" : `${multiplier} servings`;
  return (
    `Estimated nutrition for ${servingWord} of ${product.name}: ${parts.join(", ")}. ` +
    `Nutrition values are estimates and may vary based on preparation, ingredients and serving size.`
  );
}

function describePrice(product) {
  if (Array.isArray(product.variants) && product.variants.length) {
    const list = product.variants.map((v) => `${v.label} — ₹${v.price}`).join(", ");
    return `${product.name}: ${list}.`;
  }
  return `${product.name} is ₹${product.price}.`;
}

function listCategory(category, products) {
  const items = products.filter((p) => p.category === category.id);
  if (items.length === 0) return `There's nothing currently listed under ${category.label}.`;
  const list = items.map((p) => `${p.name} (₹${p.price})`).join(", ");
  return `${category.label}: ${list}.`;
}

/** Main entry point. Returns { text, matched } — matched=false means the generic help message was used. */
function answer(message, productIdHint) {
  const facts = retrieveFacts(message, productIdHint);
  const { product, category, multiplier } = facts;

  if (/chocolate/i.test(message) && /which|what|show/i.test(message) && !product) {
    if (facts.chocolateProducts.length === 0) {
      return { text: "None of the current menu items list chocolate or cocoa as an ingredient.", matched: true };
    }
    const list = facts.chocolateProducts.map((p) => p.name).join(", ");
    return { text: `These items list chocolate or cocoa: ${list}.`, matched: true };
  }

  if (category && !product) {
    return { text: listCategory(category, facts.products), matched: true };
  }

  if (product) {
    if (INTENTS.nutrition.test(message)) return { text: describeNutrition(product, multiplier), matched: true };
    if (INTENTS.allergen.test(message)) return { text: describeAllergens(product), matched: true };
    if (INTENTS.ingredients.test(message)) return { text: describeIngredients(product), matched: true };
    if (INTENTS.price.test(message)) return { text: describePrice(product), matched: true };
    // Product named but no specific intent recognised: give the fullest safe summary.
    return {
      text: `${describeIngredients(product)} ${describePrice(product)} ${describeNutrition(product, 1)}`,
      matched: true,
    };
  }

  return {
    text:
      "I can answer questions about DE.25's menu — ingredients, confirmed allergens, price, or nutrition for a specific item. " +
      "Try something like \"What ingredients are in the Blueberry Cheesecake?\" or \"Show me savouries.\"",
    matched: false,
  };
}

module.exports = { answer, retrieveFacts };
