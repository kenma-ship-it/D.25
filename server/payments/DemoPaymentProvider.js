/**
 * Demo payment provider — the default until a real gateway is configured.
 * No money moves. The checkout shows a clearly-labelled demo payment sheet
 * where the customer (or a tester) picks "pay" or "simulate a failure", so
 * every payment path the owner dashboard has to handle — paid, failed,
 * retried, expired — can be exercised without a gateway account.
 */
const crypto = require("crypto");

class DemoPaymentProvider {
  get name() {
    return "demo";
  }
  get isLive() {
    return false;
  }

  async createPayment(order, amountPaise) {
    const gatewayOrderId = `demo_order_${crypto.randomBytes(6).toString("hex")}`;
    return {
      gatewayOrderId,
      checkout: { provider: "demo", gatewayOrderId, amountPaise, currency: "INR" },
    };
  }

  /** A simulated gateway payment, in the same normalized shape the Razorpay adapter returns. */
  simulate(gatewayOrderId, amountPaise, outcome) {
    const paid = outcome === "success";
    return {
      paymentId: `demo_pay_${crypto.randomBytes(6).toString("hex")}`,
      gatewayOrderId,
      status: paid ? "paid" : "failed",
      amountPaise,
      method: "upi",
      errorCode: paid ? null : "DEMO_DECLINED",
      errorReason: paid ? null : "Demo: payment declined (simulated failure)",
      at: new Date().toISOString(),
    };
  }

  /** Nothing to look up remotely — demo payments are recorded directly. */
  async listOrderPayments() {
    return [];
  }
}

module.exports = { DemoPaymentProvider };
