/**
 * NotificationProvider — the contract every "tell someone an order happened"
 * backend must implement.
 *
 * Same pattern as server/delivery/DeliveryProvider.js on purpose: checkout
 * and the admin routes only ever call through server/notifications/index.js's
 * getNotificationProvider(), never DemoNotificationProvider or
 * WhatsAppCloudProvider directly. That's what lets DE.25 go from "no real
 * WhatsApp account yet" to "really sending messages" by changing env vars
 * alone — no checkout or route code changes.
 *
 * Every method returns a plain, JSON-serializable result shaped the same
 * way regardless of which provider produced it, and — critically — every
 * method is designed to never throw in a way that could fail checkout.
 * Sending a receipt is a side effect of a successful order, not a
 * precondition for one; a WhatsApp outage must never mean a customer can't
 * check out.
 */
class NotificationProvider {
  /** @returns {string} A short identifier, e.g. "demo" or "whatsapp-cloud". */
  get name() {
    throw new Error("NotificationProvider.name must be implemented by a subclass");
  }

  /**
   * Alerts the shop owner that a new order has been placed.
   * @param {object} order - the full order record (server/lib/orders.js shape)
   * @returns {Promise<{provider:string, sent:boolean, isLive:boolean, to:string|null, error?:string}>}
   */
  async notifyOwnerNewOrder(_order) {
    throw new Error("notifyOwnerNewOrder() must be implemented by a subclass");
  }

  /**
   * Sends the customer their order slip (items, total, shop contact info).
   * @param {object} order - the full order record
   * @returns {Promise<{provider:string, sent:boolean, isLive:boolean, to:string|null, error?:string}>}
   */
  async sendCustomerOrderSlip(_order) {
    throw new Error("sendCustomerOrderSlip() must be implemented by a subclass");
  }

  /**
   * Sends a one-time phone verification code (My Orders lookup, checkout).
   * Unlike the two methods above, a failure here SHOULD surface to the
   * caller — the customer is waiting for this code.
   * @returns {Promise<{provider:string, sent:boolean, isLive:boolean, to:string|null, error?:string}>}
   */
  async sendVerificationCode(_phone, _code) {
    throw new Error("sendVerificationCode() must be implemented by a subclass");
  }
}

module.exports = { NotificationProvider };
