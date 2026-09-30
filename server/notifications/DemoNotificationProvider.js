const fs = require("fs");
const path = require("path");
const { NotificationProvider } = require("./NotificationProvider");
const { ownerMessage, customerSlipMessage } = require("./messages");

const LOG_PATH = path.join(__dirname, "..", "..", "data", "notifications.json");
const MAX_LOG_ENTRIES = 200;

/**
 * DemoNotificationProvider — active by default (WHATSAPP_NOTIFICATIONS_ENABLED=false).
 *
 * This never calls any real messaging API. It records exactly what would
 * have been sent, to whom, and when, into data/notifications.json — so the
 * owner dashboard has something real to show ("here's proof the system
 * fires on every order") even before a real WhatsApp Business account
 * exists. Every entry is stamped isLive:false so nothing here can be
 * mistaken for a message that actually reached anyone's phone.
 */
class DemoNotificationProvider extends NotificationProvider {
  get name() {
    return "demo";
  }

  _record(entry) {
    const full = { ...entry, isLive: false, sentAt: new Date().toISOString() };
    // eslint-disable-next-line no-console
    console.log(`[notifications:demo] to ${full.to || "(no number on file)"} — ${full.type}\n${full.message}`);
    try {
      let log = [];
      try {
        log = JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
        if (!Array.isArray(log)) log = [];
      } catch (_err) {
        log = [];
      }
      log.unshift(full);
      if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), "utf8");
    } catch (err) {
      // A failed log write must never break checkout.
      // eslint-disable-next-line no-console
      console.error("[notifications:demo] failed to persist notifications.json:", err.message);
    }
    return full;
  }

  async notifyOwnerNewOrder(order) {
    const to = process.env.OWNER_WHATSAPP_NUMBER || null;
    const message = ownerMessage(order);
    this._record({ type: "owner_new_order", orderId: order.orderId, to, message });
    return { provider: this.name, sent: true, isLive: false, to };
  }

  async sendVerificationCode(phone, code) {
    // Console only: codes are deliberately NOT written to notifications.json
    // (that log is shown in the owner dashboard).
    // eslint-disable-next-line no-console
    console.log(`[notifications:demo] verification code for ${phone}: ${code}`);
    return { provider: this.name, sent: true, isLive: false, to: phone };
  }

  async sendCustomerOrderSlip(order) {
    const to = order.customer.phone || null;
    const message = customerSlipMessage(order, process.env.SHOP_CONTACT_PHONE);
    this._record({ type: "customer_order_slip", orderId: order.orderId, to, message });
    return { provider: this.name, sent: true, isLive: false, to };
  }
}

module.exports = { DemoNotificationProvider, LOG_PATH };
