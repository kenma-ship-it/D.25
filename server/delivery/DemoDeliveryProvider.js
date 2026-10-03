const { DeliveryProvider } = require("./DeliveryProvider");

/**
 * DemoDeliveryProvider — active by default (BORZO_DELIVERY_ENABLED=false).
 *
 * This never calls any real courier network. It produces a plausible,
 * clearly-labelled placeholder quote (isLive:false everywhere) so the
 * checkout flow can be demoed end-to-end before Borzo is actually
 * connected. Every response includes isLive:false specifically so the
 * frontend can render "Demo delivery estimate" instead of implying a real
 * courier has been booked — see public/js/checkout.js.
 */
class DemoDeliveryProvider extends DeliveryProvider {
  get name() {
    return "demo";
  }

  async getDeliveryQuote(address) {
    // A simple, deterministic placeholder: a flat base fee plus a small
    // per-character variation on the pincode so different addresses don't
    // all show the exact same number in a demo. This is NOT a real
    // distance/traffic calculation — it exists only so the demo checkout
    // has something plausible to show.
    const pin = String(address.pincode || "000000");
    const variation = (pin.charCodeAt(pin.length - 1) || 0) % 30;
    const feeRupees = 40 + variation;
    const etaMinutes = 45 + variation;
    return { provider: this.name, environment: "demo", feeRupees, etaMinutes, isLive: false };
  }

  // Same shape as BorzoDeliveryProvider's delivery record, so the dashboard
  // renders both the same way — but status "simulated" and no tracking
  // link or courier, because no courier exists.
  async createDeliveryOrder(order) {
    return {
      provider: this.name,
      environment: "demo",
      isLive: false,
      deliveryOrderId: `DEMO-${order.orderId}`,
      borzoStatus: null,
      status: "simulated",
      statusLabel: "Simulated — no courier booked",
      trackingUrl: null,
      courier: null,
      feeRupees: null,
    };
  }

  async getDeliveryStatus(deliveryOrderId) {
    return {
      provider: this.name,
      environment: "demo",
      isLive: false,
      deliveryOrderId,
      status: "simulated",
      statusLabel: "Simulated — no courier booked",
      trackingUrl: null,
      courier: null,
    };
  }

  async cancelDelivery(deliveryOrderId) {
    return { provider: this.name, cancelled: true, isLive: false, deliveryOrderId };
  }

  async trackDelivery(deliveryOrderId) {
    return { provider: this.name, trackingUrl: null, status: "demo_pending", isLive: false, deliveryOrderId };
  }
}

module.exports = { DemoDeliveryProvider };
