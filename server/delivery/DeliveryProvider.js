/**
 * DeliveryProvider — the contract every delivery backend must implement.
 *
 * The rest of the app (checkout, order routes) only ever calls through this
 * interface via server/delivery/index.js's getDeliveryProvider(). It never
 * imports DemoDeliveryProvider or BorzoDeliveryProvider directly. That is
 * the whole point of this file existing: swapping which provider is active
 * (today: Demo, later: Borzo once BORZO_DELIVERY_ENABLED=true and real
 * credentials are set) never requires touching checkout, the cart, or any
 * UI code — only the factory's provider selection changes.
 *
 * Every method returns a plain, JSON-serializable object shaped the same
 * way regardless of which provider produced it, so callers never need to
 * branch on which provider is active.
 */
class DeliveryProvider {
  /** @returns {string} A short identifier surfaced to the UI, e.g. "demo" or "borzo". */
  get name() {
    throw new Error("DeliveryProvider.name must be implemented by a subclass");
  }

  /**
   * @param {{house:string,street:string,area:string,city:string,pincode:string,landmark?:string}} address
   * @returns {Promise<{provider:string, feeRupees:number, etaMinutes:number, isLive:boolean}>}
   */
  async getDeliveryQuote(_address) {
    throw new Error("getDeliveryQuote() must be implemented by a subclass");
  }

  /**
   * @param {{orderId:string, address:object, customer:object}} order
   * @returns {Promise<{provider:string, deliveryOrderId:string, status:string, isLive:boolean}>}
   */
  async createDeliveryOrder(_order) {
    throw new Error("createDeliveryOrder() must be implemented by a subclass");
  }

  /**
   * @param {string} deliveryOrderId
   * @returns {Promise<{provider:string, status:string, isLive:boolean}>}
   */
  async getDeliveryStatus(_deliveryOrderId) {
    throw new Error("getDeliveryStatus() must be implemented by a subclass");
  }

  /**
   * @param {string} deliveryOrderId
   * @returns {Promise<{provider:string, cancelled:boolean, isLive:boolean}>}
   */
  async cancelDelivery(_deliveryOrderId) {
    throw new Error("cancelDelivery() must be implemented by a subclass");
  }

  /**
   * @param {string} deliveryOrderId
   * @returns {Promise<{provider:string, trackingUrl:string|null, status:string, isLive:boolean}>}
   */
  async trackDelivery(_deliveryOrderId) {
    throw new Error("trackDelivery() must be implemented by a subclass");
  }
}

module.exports = { DeliveryProvider };
