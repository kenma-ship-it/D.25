/**
 * Message text shared by every NotificationProvider, so the demo log and a
 * real WhatsApp send are never allowed to drift into saying different
 * things. Nothing here invents information: the delivery-partner section is
 * only ever the honest "DE.25 is handling delivery directly for now" line
 * unless order.deliveryQuote.isLive is true — never a fabricated courier
 * name, phone number, or tracking link.
 */

function formatLines(order) {
  return order.lines
    .map((l) => `${l.qty} x ${l.name}${l.variantLabel ? ` (${l.variantLabel})` : ""} - Rs ${l.lineTotal}`)
    .join("\n");
}

/** The line describing who's delivering the order — never invents a courier. */
function deliveryLine(order) {
  const quote = order.deliveryQuote || {};
  // The Borzo sandbox books test orders only — no rider ever comes, so the
  // customer is told the same as with the demo provider.
  const isLive = Boolean(quote.isLive) && quote.environment !== "test";
  if (isLive) {
    // Real Borzo delivery: once BorzoDeliveryProvider is live, order.deliveryOrderId
    // and a real courier assignment exist — this is the one place that real
    // courier contact/tracking info should be substituted in once available.
    return `Your delivery partner's details and live tracking will be shared separately once assigned.`;
  }
  return `DE.25 is preparing and delivering this order directly for now.`;
}

/** For the owner: which courier network the order went to (nothing for the demo provider). */
function courierLine(order) {
  const quote = order.deliveryQuote || {};
  if (!quote.isLive) return "";
  if (quote.environment === "test") return `\nCourier: Borzo sandbox test booking (Rs ${quote.feeRupees}) - no rider will come`;
  return `\nCourier: Borzo booking requested (Rs ${quote.feeRupees}) - see dashboard for rider and tracking`;
}

// Exactly how this order was paid, in words the owner can't misread:
// a simulated or test-mode payment must never look like money received.
function paymentLine(order) {
  const p = order.payment || {};
  if (order.isSample || p.method === "sample") return "Payment: none (sample order)";
  if (p.simulated || p.method === "demo") return "Payment: SIMULATED (demo mode - no money received)";
  if (p.method === "razorpay") {
    const test = p.mode === "test" ? " [TEST MODE - no real money]" : "";
    return `Payment: Paid online via Razorpay${test}${p.paymentId ? ` (${p.paymentId})` : ""}`;
  }
  return "Payment: online";
}

function ownerMessage(order) {
  const addr = order.address;
  const addressLine = [addr.house, addr.street, addr.area, addr.city, addr.pincode].filter(Boolean).join(", ");
  return (
    `${order.isSample ? "[SAMPLE - not a real customer] " : ""}New order ${order.token} - Rs ${order.total}\n` +
    `${order.customer.name} - ${order.customer.phone}\n` +
    `${formatLines(order)}\n` +
    `Deliver to: ${addressLine}${addr.landmark ? ` (near ${addr.landmark})` : ""}\n` +
    // Sent only after payment is confirmed (lib/placeOrder.js dispatchPaidOrder).
    paymentLine(order) +
    courierLine(order)
  );
}

function customerSlipMessage(order, shopPhone) {
  return (
    `Thank you for your order from DE.25!\n\n` +
    `Order ${order.token}\n${formatLines(order)}\n` +
    `Total: Rs ${order.total}\n\n` +
    `${deliveryLine(order)}\n\n` +
    `Questions about your order? Call DE.25${shopPhone ? ` at ${shopPhone}` : ""}.`
  );
}

module.exports = { ownerMessage, customerSlipMessage, deliveryLine, formatLines, paymentLine };
