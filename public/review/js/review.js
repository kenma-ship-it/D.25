/**
 * QR review page: stars -> what you had -> AI draft -> copy & post on Google.
 *
 * Every rating gets the same path to Google (no "only happy customers go to
 * Google" gating — that's against Google's review policies). The draft is a
 * suggestion the customer edits; Google can't accept pre-filled text, so we
 * copy it to the clipboard and send them to the review screen to paste it.
 */
let CATEGORY_ORDER = []; // [id, label] pairs, from data/menu.json via /api/menu
const STAR_WORDS = { 1: "Poor", 2: "Not great", 3: "Okay", 4: "Great", 5: "Loved it" };
const REDIRECT_DELAY_MS = 1800;

const $ = (sel) => document.querySelector(sel);
const state = { rating: 0, items: new Set(), tags: new Set(), category: "cakes", seed: 1, products: [], config: null, busy: false };

async function getJSON(url, options) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
  return data;
}

function setProgress(step) {
  document.querySelectorAll(".rv-progress li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("is-current", n === step);
    li.classList.toggle("is-done", n < step);
    if (n === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
}

function chip(label, pressed, extraClass = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `rv-chip ${extraClass}`.trim();
  b.textContent = label;
  b.setAttribute("aria-pressed", pressed ? "true" : "false");
  return b;
}

/* ---------- Step 1: stars ---------- */
function paintStars(n) {
  document.querySelectorAll(".rv-stars label").forEach((label, i) => label.classList.toggle("is-on", i < n));
}
function onRating(n) {
  const first = state.rating === 0;
  state.rating = n;
  paintStars(n);
  $("#rv-star-word").textContent = `${n} star${n > 1 ? "s" : ""} — ${STAR_WORDS[n]}`;
  // Tags offered depend on the rating; drop any that no longer apply.
  renderTags();
  $("#rv-order").hidden = false;
  if ($("#rv-draft").hidden) setProgress(2);
  if (first) $("#rv-order").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

/* ---------- Step 2: items + tags ---------- */
function productsIn(cat) {
  return state.products.filter((p) => p.category === cat && p.availability !== false);
}
function renderCats() {
  const wrap = $("#rv-cats");
  wrap.innerHTML = "";
  for (const [id, label] of CATEGORY_ORDER) {
    if (!productsIn(id).length) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rv-cat";
    b.dataset.cat = id;
    b.setAttribute("aria-pressed", state.category === id ? "true" : "false");
    const count = productsIn(id).filter((p) => state.items.has(p.productId)).length;
    const name = document.createElement("span");
    name.textContent = label;
    const slot = document.createElement("span");
    slot.className = "rv-count-slot";
    if (count) {
      const c = document.createElement("span");
      c.className = "rv-count";
      c.textContent = String(count);
      const sr = document.createElement("span");
      sr.className = "visually-hidden";
      sr.textContent = ` (${count} selected)`;
      slot.append(c);
      name.append(sr);
    }
    b.append(name, slot);
    b.addEventListener("click", () => {
      state.category = id;
      renderCats();
      renderItems();
    });
    wrap.appendChild(b);
  }
}
function renderItems() {
  const wrap = $("#rv-items");
  wrap.innerHTML = "";
  for (const p of productsIn(state.category)) {
    const b = chip(p.name, state.items.has(p.productId));
    b.addEventListener("click", () => {
      if (state.items.has(p.productId)) state.items.delete(p.productId);
      else if (state.items.size < 8) state.items.add(p.productId);
      b.setAttribute("aria-pressed", state.items.has(p.productId) ? "true" : "false");
      renderCats();
      renderPicked();
    });
    wrap.appendChild(b);
  }
}
function renderPicked() {
  const names = state.products.filter((p) => state.items.has(p.productId)).map((p) => p.name);
  $("#rv-picked").textContent = names.length ? `You had: ${names.join(", ")}` : "";
}
function renderTags() {
  const wrap = $("#rv-tags");
  wrap.innerHTML = "";
  if (!state.config) return;
  const r = state.rating;
  const pos = r >= 3 ? state.config.tags.positive : [];
  const neg = r <= 3 ? state.config.tags.issues : [];
  const allowed = new Set([...pos, ...neg].map((t) => t.id));
  for (const id of [...state.tags]) if (!allowed.has(id)) state.tags.delete(id);
  for (const [list, cls] of [[pos, ""], [neg, "rv-chip-issue"]]) {
    for (const t of list) {
      const b = chip(t.label, state.tags.has(t.id), cls);
      b.addEventListener("click", () => {
        if (state.tags.has(t.id)) state.tags.delete(t.id);
        else state.tags.add(t.id);
        b.setAttribute("aria-pressed", state.tags.has(t.id) ? "true" : "false");
      });
      wrap.appendChild(b);
    }
  }
}

/* ---------- Step 3: draft ---------- */
async function suggest({ another = false } = {}) {
  if (state.busy) return;
  const err = $("#rv-suggest-error");
  err.hidden = true;
  if (!state.rating) {
    err.textContent = "Please tap a star rating first.";
    err.hidden = false;
    return;
  }
  if (!state.items.size) {
    err.textContent = "Please pick at least one thing you had.";
    err.hidden = false;
    return;
  }
  if (another) state.seed += 1;
  state.busy = true;
  const btn = another ? $("#rv-again") : $("#rv-suggest");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Writing…";
  try {
    const res = await getJSON("/api/review/suggest", {
      method: "POST",
      body: JSON.stringify({ rating: state.rating, items: [...state.items], tags: [...state.tags], seed: state.seed }),
    });
    $("#rv-text").value = res.text;
    $("#rv-engine").textContent = res.engine === "grok" ? "Drafted by Grok AI — edit freely" : "Suggested draft — edit freely";
    $("#rv-draft").hidden = false;
    $("#rv-handoff").hidden = true;
    setProgress(3);
    if (!another) $("#rv-draft").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    $("#rv-text").focus({ preventScroll: !another });
  } catch (e) {
    const target = another ? null : err;
    if (target) {
      target.textContent = e.message;
      target.hidden = false;
    } else {
      $("#rv-engine").textContent = e.message;
    }
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_e) {
    // Fallback for older browsers / non-secure contexts.
    const ta = $("#rv-text");
    ta.focus();
    ta.select();
    try {
      return document.execCommand("copy");
    } catch (_e2) {
      return false;
    }
  }
}

async function postToGoogle() {
  const text = $("#rv-text").value.trim();
  if (text.length < 10) {
    $("#rv-text").focus();
    return;
  }
  const copied = await copyText(text);
  const url = state.config ? state.config.googleReviewUrl : "https://www.google.com/maps";
  const handoff = $("#rv-handoff");
  $("#rv-handoff-stars").textContent = `${state.rating} star${state.rating > 1 ? "s" : ""}`;
  handoff.querySelector(".rv-handoff-title").textContent = copied ? "Review copied" : "Copy didn't work — select the text above and copy it";
  const link = $("#rv-open-google");
  link.href = url;
  handoff.hidden = false;
  if (copied) setTimeout(() => window.location.assign(url), REDIRECT_DELAY_MS);
  else link.textContent = "Open Google reviews";
}

async function init() {
  document.querySelectorAll('.rv-stars input[name="rating"]').forEach((input) => {
    input.addEventListener("change", () => onRating(Number(input.value)));
  });
  $("#rv-suggest").addEventListener("click", () => suggest());
  $("#rv-again").addEventListener("click", () => suggest({ another: true }));
  $("#rv-post").addEventListener("click", postToGoogle);

  try {
    const [config, menu] = await Promise.all([getJSON("/api/review/config"), getJSON("/api/review/menu")]);
    state.config = config;
    CATEGORY_ORDER = (menu.categories || []).map((c) => [c.id, c.label]);
    state.products = (menu.items || []).map((i) => ({ productId: i.id, name: i.name, category: i.category }));
    // Optional link back to the main DE.25 website (MAIN_SITE_URL).
    if (config.mainSiteUrl) {
      $("#rv-brand").href = config.mainSiteUrl;
      const a = document.createElement("a");
      a.href = config.mainSiteUrl;
      a.textContent = "Visit the DE.25 website";
      $("#rv-site-link").append(" ", a);
    }
    state.category = CATEGORY_ORDER.map(([id]) => id).find((id) => productsIn(id).length) || "cakes";
    renderCats();
    renderItems();
    renderTags();
  } catch (e) {
    $("#rv-items").textContent = "Couldn't load the menu. Please refresh the page.";
  }
}

init();
