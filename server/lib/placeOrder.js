/**
 * The order pipeline shared by real checkout (routes/checkout.js) and the
 * owner dashboard's sample orders (lib/sampleOrders.js), so a sample order
 * exercises exactly the path a customer's order takes. It runs in two
 * halves with a payment in between:
 *
 *   createPendingOrder:  delivery quote -> server-side pricing ->
 *                        order stored as AWAITING_PAYMENT
 *   ... payment confirmed (server/payments/index.js) ...
 *   dispatchPaidOrder:   courier booked (Borzo or demo) ->
 *                        owner/customer notifications -> demo kitchen timer
 *
 * Nothing in the second half ever runs for an unpaid order: no courier is
 * booked and no one is messaged about food nobody paid for.
 *
 * Courier booking is fire-and-forget: a courier network being briefly slow
 * or down must never undo an already-paid order. The outcome — success or
 * failure — is written onto the order (order.delivery) so the owner
 * dashboard always shows what happened.
 */
const { getDeliveryProvider } = require("../delivery");
const { priceCart } = require("./pricing");
const { createOrder, setDelivery, startDemoProgression } = require("./orders");
const { notifyNewOrder } = require("../notifications");

async function createPendingOrder({
  customer,
  address,
  items,
  paymentMethod,
  windowMinutes = 30,
  customerPhoneVerified = false,
  isSample = false,
}) {
  const provider = getDeliveryProvider();

  // A quote failure is tagged so checkout can answer 502 for it while any
  // other failure (e.g. the order store) stays a 500.
  let deliveryQuote;
  try {
    deliveryQuote = await provider.getDeliveryQuote(address);
  } catch (err) {
    err.stage = "quote";
    throw err;
  }
  const pricing = priceCart(items, deliveryQuote);

  const createdAt = Date.now();
  const order = await createOrder({
    customer,
    address,
    pricing,
    paymentMethod,
    customerPhoneVerified,
    isSample,
    payment: {
      method: paymentMethod,
      status: "pending",
      // Integer paise, fixed here from server-side pricing — the only
      // amount any payment for this order is ever checked against.
      amountPaise: Math.round(pricing.total * 100),
      currency: "INR",
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + windowMinutes * 60000).toISOString(),
    },
  });

  return { order, deliveryQuote };
}

/** Runs once per order, right after its payment is confirmed. Returns the courier-booking promise. */
function dispatchPaidOrder(order, { notify = true } = {}) {
  const provider = getDeliveryProvider();
  const deliveryQuote = order.deliveryQuote || {};

  const bookedAt = new Date().toISOString();
  const deliveryPromise = provider
    .createDeliveryOrder({
      orderId: order.orderId,
      token: order.token,
      address: order.address,
      customer: order.customer,
      lines: order.lines,
      isSample: order.isSample,
    })
    .then((booking) => ({ ...booking, createdAt: bookedAt, lastSyncedAt: bookedAt, error: null }))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[order] courier booking failed (order still stands):", err.message);
      return {
        provider: provider.name,
        environment: deliveryQuote.environment || null,
        isLive: Boolean(deliveryQuote.isLive),
        deliveryOrderId: null,
        status: "failed",
        statusLabel: "Courier booking failed",
        trackingUrl: null,
        courier: null,
        createdAt: bookedAt,
        error: err.publicMessage || err.message,
      };
    })
    .then(async (record) => {
      // Mutate the in-memory object too, so anything still holding it sees
      // the booking without a re-read.
      order.delivery = record;
      if (record.deliveryOrderId) order.deliveryOrderId = record.deliveryOrderId;
      try {
        await setDelivery(order.orderId, record);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[order] failed to store delivery record:", err.message);
      }
      return record;
    });

  // Side effects of a paid order, not conditions for one —
  // notifyNewOrder() catches its own failures.
  if (notify) notifyNewOrder(order, { customerPhoneVerified: Boolean(order.customerPhoneVerified) });

  // With a real courier network, the last statuses come from the courier
  // (server/delivery/borzoSync.js) — the demo timer must not fake them.
  if (!deliveryQuote.isLive) {
    Promise.resolve(startDemoProgression(order.orderId)).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[order] couldn't start demo progression:", err.message);
    });
  }

  return deliveryPromise;
}

module.exports = { createPendingOrder, dispatchPaidOrder };
