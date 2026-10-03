/**
 * Review suggestions for the QR review page (public/review/index.html).
 *
 * The customer picks: a star rating (1–5), what they had (real menu items),
 * and optionally a few "what stood out" tags from a fixed list. From that we
 * draft a short first-person review they can edit, copy, and post on Google.
 *
 * Two engines:
 *   - Grok (xAI)  — used when XAI_API_KEY is set. Called server-side only, so
 *                   the key never reaches the browser.
 *   - Built-in    — template writer with no API, no cost. Used when no key is
 *                   set AND as an automatic fallback if Grok errors or times
 *                   out, so the page never dead-ends in front of a customer.
 *
 * Honesty rules (both engines):
 *   - The draft matches the stars chosen. 2 stars reads like 2 stars; it is
 *     never nudged upward. (Google prohibits businesses from steering
 *     reviews or soliciting only positive ones.)
 *   - It only mentions items and tags the customer actually picked. No free
 *     text from the customer is sent to the model — inputs are menu ids and
 *     tag ids validated against fixed lists — so there is nothing to
 *     prompt-inject and nothing invented.
 *   - It's a suggestion: the page tells the customer to edit it into their
 *     own words before posting.
 */

const POSITIVE_TAGS = {
  taste: "Taste",
  fresh: "Freshness",
  presentation: "Presentation",
  packaging: "Packaging",
  value: "Value for money",
  service: "Friendly service",
  delivery: "On-time delivery",
  ambience: "Shop ambience",
};
const ISSUE_TAGS = {
  "too-sweet": "Too sweet",
  "not-fresh": "Not fresh",
  "small-portion": "Small portion",
  pricey: "Too pricey",
  "late-delivery": "Late delivery",
  "slow-service": "Slow service",
  "packaging-issue": "Packaging issue",
  "wrong-order": "Wrong item",
};

/** Tags offered for a given rating: highs praise, lows describe issues, 3★ gets both. */
function tagsForRating(rating) {
  if (rating >= 4) return POSITIVE_TAGS;
  if (rating <= 2) return ISSUE_TAGS;
  return { ...POSITIVE_TAGS, ...ISSUE_TAGS };
}

function joinList(words) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// Small seeded PRNG so "Try another" gives a different but reproducible draft.
function rng(seed) {
  let s = (Number(seed) || 1) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

const OPENERS = {
  5: ["Absolutely loved my visit to DE.25.", "DE.25 is a real gem.", "Such a lovely experience at DE.25.", "Can't say enough good things about DE.25."],
  4: ["Really enjoyed DE.25.", "Had a very good experience at DE.25.", "DE.25 was a nice find.", "Good experience overall at DE.25."],
  3: ["DE.25 was okay overall.", "Mixed experience at DE.25.", "Decent, but a few things could be better at DE.25.", "An average visit to DE.25."],
  2: ["Honestly a bit disappointed with DE.25 this time.", "My experience at DE.25 wasn't great.", "Expected more from DE.25.", "DE.25 didn't quite work for me this time."],
  1: ["Unfortunately a poor experience at DE.25.", "Very disappointed with DE.25 this time.", "Not happy with my order from DE.25.", "Sadly DE.25 let me down this time."],
};
const ITEM_LINES = {
  high: ["The {items} {was} delicious.", "I had the {items} and {it} {was} really good.", "Tried the {items} — {it} hit the spot.", "The {items} {was} made really well."],
  mid: ["I had the {items}.", "Tried the {items}.", "Ordered the {items}."],
  low: ["I ordered the {items}.", "I had the {items}.", "Tried the {items}."],
};
const CLOSERS = {
  5: ["Highly recommend!", "Will definitely be back for more.", "A must-try for dessert lovers.", "Already planning my next order."],
  4: ["Would recommend.", "Will be back.", "Worth trying.", "Looking forward to trying more of the menu."],
  3: ["Might give it another try.", "Hope it's better next time.", "Has potential."],
  2: ["Hope they improve.", "Hoping things are better next time."],
  1: ["Hope the team looks into this.", "Hope they fix these issues."],
};

/**
 * Built-in writer.
 * @param {{rating:number, itemNames:string[], tagLabels:{positive:string[], issues:string[]}, seed?:number}} input
 */
function builtInSuggest({ rating, itemNames, tagLabels, seed = 1 }) {
  const rand = rng(seed);
  const parts = [pick(rand, OPENERS[rating])];
  const band = rating >= 4 ? "high" : rating === 3 ? "mid" : "low";
  if (itemNames.length) {
    const plural = itemNames.length > 1;
    parts.push(
      pick(rand, ITEM_LINES[band])
        .replace("{items}", joinList(itemNames))
        .replace("{was}", plural ? "were" : "was")
        .replace("{it}", plural ? "they" : "it")
    );
  }
  const pos = tagLabels.positive.map((t) => t.toLowerCase());
  const neg = tagLabels.issues.map((t) => t.toLowerCase());
  if (pos.length) parts.push(`${rating >= 4 ? "Loved" : "Liked"} the ${joinList(pos)}.`);
  if (neg.length) parts.push(`${rating >= 3 ? "One thing to improve:" : "Issues:"} ${joinList(neg)}.`);
  parts.push(pick(rand, CLOSERS[rating]));
  return parts.join(" ");
}

function buildGrokMessages({ rating, itemNames, tagLabels, seed }) {
  const system =
    "You write short Google review drafts for customers of DE.25, a dessert shop in Ghansoli, Navi Mumbai " +
    "(cakes, pastries, savouries, sips). The customer will edit and post it themselves. Rules: " +
    "write in first person as the customer; 2 to 4 sentences, under 70 words; the tone MUST match the star rating exactly " +
    "(5 = delighted, 4 = happy, 3 = mixed, 2 = disappointed, 1 = unhappy) and never sound more positive than the rating; " +
    "mention only the items and points listed — do not invent dishes, prices, staff names, or details; " +
    "plain, natural Indian English; no hashtags, no emojis, no quotation marks, no star symbols. Output only the review text.";
  const user =
    `Star rating: ${rating} out of 5.\n` +
    `What I had: ${itemNames.length ? itemNames.join(", ") : "not specified"}.\n` +
    `What I liked: ${tagLabels.positive.length ? tagLabels.positive.join(", ") : "nothing specific"}.\n` +
    `What could be better: ${tagLabels.issues.length ? tagLabels.issues.join(", ") : "nothing specific"}.\n` +
    `Variation #${seed} — word it differently from other variations.`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Pulls the generated text out of an xAI Responses API body (skips any reasoning items). */
function extractResponsesText(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  for (const item of Array.isArray(body.output) ? body.output : []) {
    for (const c of Array.isArray(item && item.content) ? item.content : []) {
      if (c && (c.type === "output_text" || c.type === "text") && typeof c.text === "string" && c.text.trim()) return c.text;
    }
  }
  // Tolerate an OpenAI chat-completions-shaped body too.
  const choice = body.choices && body.choices[0];
  if (choice && choice.message && typeof choice.message.content === "string") return choice.message.content;
  return "";
}

/** Normalises model output into a single clean paragraph, or "" if unusable. */
function cleanDraft(text) {
  let t = String(text || "")
    .replace(/[★☆⭐]/g, "") // star symbols
    .replace(/#\w+/g, "") // hashtags
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  if (t.length > 600) t = `${t.slice(0, 600).replace(/\s+\S*$/, "")}…`;
  return t.length >= 20 ? t : "";
}

async function grokSuggest(input, { fetchImpl = fetch, timeoutMs = 9000 } = {}) {
  const apiKey = process.env.XAI_API_KEY;
  const model = process.env.XAI_MODEL || "grok-4.7";
  const baseUrl = (process.env.XAI_BASE_URL || "https://api.x.ai/v1").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: buildGrokMessages(input), max_output_tokens: 400, store: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`xAI responded ${res.status}: ${errText.slice(0, 200)}`);
    }
    const text = cleanDraft(extractResponsesText(await res.json()));
    if (!text) throw new Error("xAI returned no usable text");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Main entry: Grok when configured, built-in otherwise or on any Grok failure.
 * @returns {Promise<{text:string, engine:"grok"|"built-in"}>}
 */
async function suggestReview(input, opts = {}) {
  if (process.env.XAI_API_KEY) {
    try {
      return { text: await grokSuggest(input, opts), engine: "grok" };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[review] Grok suggestion failed, using built-in writer:", err.message);
    }
  }
  return { text: builtInSuggest(input), engine: "built-in" };
}

/**
 * Where the "Post on Google" button goes, in priority order:
 *   GOOGLE_REVIEW_URL  — any review link the owner copies from their Google
 *                        Business Profile ("Ask for reviews" -> share link,
 *                        e.g. https://g.page/r/XXXX/review). Must be a Google URL.
 *   GOOGLE_PLACE_ID    — builds Google's official write-a-review link.
 *   neither            — a Google Maps search for the shop, so the button still
 *                        lands somewhere sensible before the listing is set up.
 */
const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*(google\.[a-z.]+|g\.page|goo\.gl|maps\.app\.goo\.gl)$/i;
function getGoogleReviewUrl() {
  const raw = (process.env.GOOGLE_REVIEW_URL || "").trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && GOOGLE_HOST.test(u.hostname)) return { url: u.toString(), configured: true };
      // eslint-disable-next-line no-console
      console.warn("[review] GOOGLE_REVIEW_URL ignored — must be an https Google / g.page link.");
    } catch (_err) {
      // eslint-disable-next-line no-console
      console.warn("[review] GOOGLE_REVIEW_URL is not a valid URL — ignored.");
    }
  }
  const placeId = (process.env.GOOGLE_PLACE_ID || "").trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(placeId)) {
    return { url: `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`, configured: true };
  }
  return { url: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("DE.25 Ghansoli Navi Mumbai"), configured: false };
}

module.exports = {
  POSITIVE_TAGS,
  ISSUE_TAGS,
  tagsForRating,
  builtInSuggest,
  buildGrokMessages,
  extractResponsesText,
  cleanDraft,
  grokSuggest,
  suggestReview,
  getGoogleReviewUrl,
};
