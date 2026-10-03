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
  const isLive = Boolean(order.deliveryQuote && order.deliveryQuote.isLive);
  if (isLive) {
    // Real Borzo delivery: once BorzoDeliveryProvider is live, order.deliveryOrderId
    // and a real courier assignment exist — this is the one place that real
    // courier contact/tracking info should be substituted in once available.
    return `Your delivery partner's details and live tracking will be shared separately once assigned.`;
  }
  return `DE.25 is preparing and delivering this order directly for now.`;
}

function ownerMessage(order) {
  const addr = order.address;
  const addressLine = [addr.house, addr.street, addr.area, addr.city, addr.pincode].filter(Boolean).join(", ");
  return (
    `New order ${order.token} - Rs ${order.total}\n` +
    `${order.customer.name} - ${order.customer.phone}\n` +
    `${formatLines(order)}\n` +
    `Deliver to: ${addressLine}${addr.landmark ? ` (near ${addr.landmark})` : ""}\n` +
    // Only ever sent once the payment gateway has confirmed the payment
    // (server/payments/service.js) — DE.25 takes online payment only.
    `Payment: PAID online${order.payment && order.payment.method ? ` (${String(order.payment.method).toUpperCase()})` : ""}` +
    `${order.payment && order.payment.paymentId ? ` - Ref ${order.payment.paymentId}` : ""}`
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

module.exports = { ownerMessage, customerSlipMessage, deliveryLine, formatLines };
