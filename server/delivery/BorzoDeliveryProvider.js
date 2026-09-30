const { DeliveryProvider } = require("./DeliveryProvider");

/**
 * BorzoDeliveryProvider — wired to Borzo's real API shape, but INACTIVE.
 *
 * The factory in ./index.js only ever constructs this class when
 * BORZO_DELIVERY_ENABLED=true *and* BORZO_API_KEY is set. Do not import or
 * instantiate this class directly from route code — go through
 * getDeliveryProvider() so the enable/disable decision stays in one place.
 *
 * Borzo has been contacted but onboarding/API credentials have not come
 * through yet, so none of the network calls below have been exercised
 * against Borzo's real API. The endpoint shapes follow Borzo's published
 * business-API documentation (calculate-order / create-order, points
 * array, X-DV-Auth-Token header) as of when this was written — verify
 * against their current docs once credentials arrive, before flipping
 * BORZO_DELIVERY_ENABLED to true in production.
 */
class BorzoDeliveryProvider extends DeliveryProvider {
  constructor({ apiKey, apiUrl, pickupAddress, pickupPhone }) {
    super();
    if (!apiKey) throw new Error("BorzoDeliveryProvider requires BORZO_API_KEY");
    this.apiKey = apiKey;
    this.apiUrl = apiUrl || "https://robot-in.borzodelivery.com/api/business/1.4";
    this.pickupAddress = pickupAddress;
    this.pickupPhone = pickupPhone;
  }

  get name() {
    return "borzo";
  }

  async _request(path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DV-Auth-Token": this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Borzo API responded ${res.status}`);
    }
    return res.json();
  }

  async getDeliveryQuote(address) {
    const data = await this._request("/calculate-order", {
      matter: "food order",
      points: [
        { address: this.pickupAddress, contact_person: { phone: this.pickupPhone } },
        { address: this._formatAddress(address), contact_person: { phone: address.phone || "" } },
      ],
    });
    return {
      provider: this.name,
      feeRupees: data.order?.payment_amount ?? null,
      etaMinutes: data.order?.delivery_fee_amount != null ? 60 : null,
      isLive: true,
    };
  }

  async createDeliveryOrder(order) {
    const data = await this._request("/create-order", {
      matter: `DE.25 order ${order.orderId}`,
      points: [
        { address: this.pickupAddress, contact_person: { phone: this.pickupPhone } },
        {
          address: this._formatAddress(order.address),
          contact_person: { name: order.customer.name, phone: order.customer.phone },
        },
      ],
    });
    return { provider: this.name, deliveryOrderId: data.order?.order_id ?? null, status: "created", isLive: true };
  }

  async getDeliveryStatus(deliveryOrderId) {
    const data = await this._request("/order-status", { order_id: deliveryOrderId });
    return { provider: this.name, status: data.order?.status ?? "unknown", isLive: true };
  }

  async cancelDelivery(deliveryOrderId) {
    await this._request("/cancel-order", { order_id: deliveryOrderId, cancel_reason_id: 1 });
    return { provider: this.name, cancelled: true, isLive: true };
  }

  async trackDelivery(deliveryOrderId) {
    const data = await this._request("/order-status", { order_id: deliveryOrderId });
    return {
      provider: this.name,
      trackingUrl: data.order?.tracking_url ?? null,
      status: data.order?.status ?? "unknown",
      isLive: true,
    };
  }

  _formatAddress(address) {
    return [address.house, address.street, address.area, address.city, address.pincode]
      .filter(Boolean)
      .join(", ");
  }
}

module.exports = { BorzoDeliveryProvider };
