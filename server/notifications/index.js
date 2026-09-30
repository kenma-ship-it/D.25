const { DemoNotificationProvider } = require("./DemoNotificationProvider");
const { WhatsAppCloudProvider } = require("./WhatsAppCloudProvider");

let cachedProvider = null;

/**
 * The single place that decides which NotificationProvider is active.
 * Same pattern as server/delivery/index.js — WHATSAPP_NOTIFICATIONS_ENABLED
 * defaults to false/unset, which is correct until DE.25 has a real WhatsApp
 * Business account, an approved message template, and both numbers
 * configured. Flipping the flag (plus the WhatsApp env vars) is the entire
 * migration from demo logging to real messages — checkout code never
 * changes.
 */
function getNotificationProvider() {
  if (cachedProvider) return cachedProvider;

  const whatsappEnabled = String(process.env.WHATSAPP_NOTIFICATIONS_ENABLED || "false").toLowerCase() === "true";
  const hasCredentials = process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (whatsappEnabled && hasCredentials) {
    cachedProvider = new WhatsAppCloudProvider({
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: process.env.WHATSAPP_API_VERSION,
      templateName: process.env.WHATSAPP_TEMPLATE_NAME,
      templateLang: process.env.WHATSAPP_TEMPLATE_LANG,
      otpTemplateName: process.env.WHATSAPP_OTP_TEMPLATE_NAME,
    });
    return cachedProvider;
  }

  if (whatsappEnabled && !hasCredentials) {
    // eslint-disable-next-line no-console
    console.warn(
      "[notifications] WHATSAPP_NOTIFICATIONS_ENABLED=true but WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID " +
        "are not both set — falling back to DemoNotificationProvider."
    );
  }

  cachedProvider = new DemoNotificationProvider();
  return cachedProvider;
}

/**
 * Fires both notifications for a new order without ever letting a
 * notification failure affect the order itself — checkout has already
 * succeeded by the time this runs. Each call is independently caught and
 * logged; a WhatsApp outage (or a not-yet-approved template, or a missing
 * phone number) never surfaces as an error to the customer.
 */
async function notifyNewOrder(order, { customerPhoneVerified = false } = {}) {
  const provider = getNotificationProvider();
  const results = { owner: null, customer: null };

  try {
    results.owner = await provider.notifyOwnerNewOrder(order);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[notifications:${provider.name}] failed to notify owner:`, err.message);
    results.owner = { provider: provider.name, sent: false, isLive: provider.name !== "demo", error: err.message };
  }

  // The customer's WhatsApp receipt only goes to a number the customer has
  // just proven they control (WhatsApp one-time code at checkout). Without
  // this, anyone could make DE.25 message any stranger's number — costing
  // the shop per-message fees and risking its WhatsApp number being
  // reported and restricted.
  if (!customerPhoneVerified) {
    results.customer = { provider: provider.name, sent: false, isLive: provider.name !== "demo", skipped: "phone-not-verified" };
    return results;
  }

  try {
    results.customer = await provider.sendCustomerOrderSlip(order);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[notifications:${provider.name}] failed to send customer order slip:`, err.message);
    results.customer = { provider: provider.name, sent: false, isLive: provider.name !== "demo", error: err.message };
  }

  return results;
}

/**
 * Can this deployment send a phone verification code right now?
 *   - Real WhatsApp configured          -> yes, over WhatsApp.
 *   - Demo provider, not production     -> yes; the code is also returned
 *                                          in the API response so the demo
 *                                          is usable without a WhatsApp account.
 *   - Demo provider in production       -> no. Codes would go nowhere, and
 *                                          exposing them in responses would
 *                                          defeat verification entirely.
 */
function getVerificationChannel() {
  const provider = getNotificationProvider();
  if (provider.name !== "demo") return { available: true, channel: "whatsapp", exposeCode: false };
  if (process.env.NODE_ENV !== "production") return { available: true, channel: "demo", exposeCode: true };
  return { available: false, channel: null, exposeCode: false };
}

/** Test/reload hook — not used in normal request handling. */
function _resetProviderCache() {
  cachedProvider = null;
}

module.exports = { getNotificationProvider, notifyNewOrder, getVerificationChannel, _resetProviderCache };
