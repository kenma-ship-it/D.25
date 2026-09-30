import { api } from "./api.js";
import { qs, qsa, trapFocus, announce } from "./utils.js";

let releaseFocusTrap = null;
let currentProductId = null;
let isOpen = false;

function appendMessage(role, text) {
  const list = qs("#ai-messages");
  const bubble = document.createElement("div");
  bubble.className = `ai-msg ai-msg-${role}`;
  bubble.textContent = text;
  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
  return bubble;
}

function appendTyping() {
  const list = qs("#ai-messages");
  const bubble = document.createElement("div");
  bubble.className = "ai-msg ai-msg-bot";
  bubble.setAttribute("aria-label", "The Food Guide is typing");
  bubble.innerHTML = `<span class="ai-msg-typing"><span></span><span></span><span></span></span>`;
  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
  return bubble;
}

async function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  appendMessage("user", trimmed);
  const typingBubble = appendTyping();

  try {
    const result = await api.askFoodGuide(trimmed, currentProductId || undefined);
    typingBubble.remove();
    appendMessage("bot", result.text);
    announce(result.text);
  } catch (err) {
    typingBubble.remove();
    appendMessage(
      "bot",
      "The Food Guide isn't available right now. Please try again in a moment, or contact DE.25 directly for urgent questions."
    );
  }
}

export function openAiGuide() {
  const fab = qs("#ai-fab");
  const panel = qs("#ai-panel");
  isOpen = true;
  panel.hidden = false;
  fab.setAttribute("aria-expanded", "true");
  releaseFocusTrap = trapFocus(panel);
  qs("#ai-input").focus();
  if (qs("#ai-messages").children.length === 0) {
    appendMessage(
      "bot",
      "Hi! Ask me about ingredients, nutrition or anything on the DE.25 menu — I only answer from DE.25's own confirmed menu information."
    );
  }
}

export function closeAiGuide() {
  const fab = qs("#ai-fab");
  const panel = qs("#ai-panel");
  isOpen = false;
  panel.hidden = true;
  fab.setAttribute("aria-expanded", "false");
  if (releaseFocusTrap) releaseFocusTrap();
  fab.focus();
}

export function openAiGuideForProduct(product) {
  currentProductId = product.productId;
  openAiGuide();
  appendMessage("bot", `What would you like to know about ${product.name}? You can ask about ingredients, allergens, nutrition or price.`);
}

export function initAiGuide() {
  const fab = qs("#ai-fab");
  fab.addEventListener("click", () => {
    if (isOpen) {
      closeAiGuide();
    } else {
      currentProductId = null;
      openAiGuide();
    }
  });
  qs("#ai-close").addEventListener("click", closeAiGuide);

  qs("#ai-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = qs("#ai-input");
    const text = input.value;
    input.value = "";
    sendMessage(text);
  });

  qsa(".ai-suggestion").forEach((btn) => {
    btn.addEventListener("click", () => sendMessage(btn.textContent));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeAiGuide();
  });
}
