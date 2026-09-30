/**
 * Thin fetch wrapper. Every call goes through here so error handling is
 * consistent: a failed request never shows the customer a raw network
 * error or stack trace, always a plain-language message (from the server
 * when it sent one, otherwise a generic fallback).
 */
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
  } catch (networkErr) {
    const err = new Error("Something went wrong connecting to DE.25. Please check your connection and try again.");
    err.cause = networkErr;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    // no/invalid JSON body — fall through with data = null
  }

  if (!res.ok) {
    const message = (data && data.error) || "Something went wrong. Please try again.";
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export const api = {
  getProducts: (category) => request(`/api/products${category && category !== "all" ? `?category=${encodeURIComponent(category)}` : ""}`),
  getProduct: (id) => request(`/api/products/${encodeURIComponent(id)}`),
  priceCart: (items) => request("/api/cart/price", { method: "POST", body: JSON.stringify({ items }) }),
  getDeliveryQuote: (address) => request("/api/delivery/quote", { method: "POST", body: JSON.stringify({ address }) }),
  checkout: (payload) => request("/api/checkout", { method: "POST", body: JSON.stringify(payload) }),
  getOrder: (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}`),
  getOrdersByPhone: (phone, verificationToken) =>
    request(`/api/orders/by-phone/${encodeURIComponent(phone)}`, {
      headers: { "Content-Type": "application/json", "X-Phone-Verification": verificationToken || "" },
    }),
  requestPhoneCode: (phone) => request("/api/verify/phone/request", { method: "POST", body: JSON.stringify({ phone }) }),
  confirmPhoneCode: (phone, code) => request("/api/verify/phone/confirm", { method: "POST", body: JSON.stringify({ phone, code }) }),
  askFoodGuide: (message, productId) => request("/api/ai-guide", { method: "POST", body: JSON.stringify({ message, productId }) }),
  submitCustomEnquiry: (payload) => request("/api/custom-enquiry", { method: "POST", body: JSON.stringify(payload) }),
};
