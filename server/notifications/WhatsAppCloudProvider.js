const { NotificationProvider } = require("./NotificationProvider");
const { ownerMessage, customerSlipMessage } = require("./messages");

/**
 * WhatsAppCloudProvider — wired to Meta's WhatsApp Cloud API shape, but
 * INACTIVE. The factory in ./index.js only ever constructs this class when
 * WHATSAPP_NOTIFICATIONS_ENABLED=true *and* WHATSAPP_ACCESS_TOKEN +
 * WHATSAPP_PHONE_NUMBER_ID are set. No credentials exist yet, so none of
 * the calls below have been exercised against Meta's real API — verify
 * against https://developers.facebook.com/docs/whatsapp/cloud-api once a
 * WhatsApp Business account exists, same caveat as BorzoDeliveryProvider.
 *
 * IMPORTANT — read before enabling this in production:
 *
 * 1. Business-initiated messages (which every message here is — the
 *    customer places an order on the *website*, not by messaging DE.25's
 *    WhatsApp number first) can only use a pre-approved MESSAGE TEMPLATE.
 *    A free-form "text" message to a customer who hasn't messaged the
 *    business in the last 24 hours will be REJECTED by WhatsApp — this is
 *    a platform policy, not a bug. You must create and get approval for a
 *    template in Meta Business Manager (Business Settings -> WhatsApp
 *    Manager -> Message Templates) before this can send anything for real.
 *    Set WHATSAPP_TEMPLATE_NAME / WHATSAPP_TEMPLATE_LANG to match it.
 * 2. The template body below assumes a single flexible {{1}} variable
 *    (the whole formatted message). If your approved template instead
 *    defines several separate variables (e.g. {{1}}=order token,
 *    {{2}}=total), change the `parameters` array in _sendTemplate() to
 *    match your template's exact variable order — WhatsApp rejects a
 *    mismatched parameter count.
 * 3. Many Indian small businesses go through a WhatsApp Business Solution
 *    Provider (Interakt, AiSensy, Gupshup, etc.) instead of Meta directly —
 *    they wrap the same underlying message API but often simplify template
 *    management. If DE.25 ends up using one of those instead of a direct
 *    Meta Cloud API app, this file's _request()/_sendTemplate() are the
 *    two functions to adapt to that provider's API shape; the rest of the
 *    app (checkout, the notification factory) doesn't need to change.
 * 4. The customer's phone number must include the country code
 *    (e.g. 91XXXXXXXXXX for India) in international format with no
 *    leading "+" or "0" — WhatsApp's API requires this exact format.
 */
class WhatsAppCloudProvider extends NotificationProvider {
  constructor({ accessToken, phoneNumberId, apiVersion, templateName, templateLang, otpTemplateName }) {
    super();
    if (!accessToken || !phoneNumberId) {
      throw new Error("WhatsAppCloudProvider requires WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID");
    }
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion = apiVersion || "v20.0";
    this.templateName = templateName || "de25_order_notification";
    this.templateLang = templateLang || "en";
    this.otpTemplateName = otpTemplateName || "de25_verification_code";
  }

  get name() {
    return "whatsapp-cloud";
  }

  _toWhatsAppNumber(rawPhone) {
    // Normalizes a 10-digit Indian mobile number to WhatsApp's expected
    // international format. Adjust the default country code if DE.25 ever
    // serves customers outside India.
    const digits = String(rawPhone || "").replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    return digits;
  }

  async _sendTemplate(toRaw, bodyText) {
    const to = this._toWhatsAppNumber(toRaw);
    if (!to) return { sent: false, to: null, error: "No phone number on file." };

    const res = await fetch(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: this.templateName,
          language: { code: this.templateLang },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: bodyText }],
            },
          ],
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { sent: false, to, error: `WhatsApp API responded ${res.status}: ${errBody.slice(0, 300)}` };
    }
    return { sent: true, to };
  }

  async notifyOwnerNewOrder(order) {
    const result = await this._sendTemplate(process.env.OWNER_WHATSAPP_NUMBER, ownerMessage(order));
    return { provider: this.name, isLive: true, ...result };
  }

  async sendCustomerOrderSlip(order) {
    const result = await this._sendTemplate(order.customer.phone, customerSlipMessage(order, process.env.SHOP_CONTACT_PHONE));
    return { provider: this.name, isLive: true, ...result };
  }

  /**
   * One-time codes must go through an AUTHENTICATION-category template
   * (Meta Business Manager -> Message Templates -> Authentication, with the
   * "Copy code" button). Meta fixes that template's body text itself
   * ("<code> is your verification code…"); the code is passed twice — once
   * for the body, once for the copy-code button — which is the shape Meta
   * documents for authentication templates. Set WHATSAPP_OTP_TEMPLATE_NAME
   * to the approved template's name. Verify against Meta's docs on first
   * live send, same caveat as the rest of this file.
   */
  async sendVerificationCode(phone, code) {
    const to = this._toWhatsAppNumber(phone);
    if (!to) return { provider: this.name, isLive: true, sent: false, to: null, error: "No phone number." };
    const res = await fetch(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: this.otpTemplateName,
          language: { code: this.templateLang },
          components: [
            { type: "body", parameters: [{ type: "text", text: code }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
          ],
        },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return { provider: this.name, isLive: true, sent: false, to, error: `WhatsApp API responded ${res.status}: ${errBody.slice(0, 300)}` };
    }
    return { provider: this.name, isLive: true, sent: true, to };
  }
}

module.exports = { WhatsAppCloudProvider };
