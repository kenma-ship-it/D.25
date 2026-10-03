/**
 * Sample orders for the owner dashboard: real menu items, sent through the
 * exact checkout pipeline (lib/placeOrder.js) and the ACTIVE delivery
 * provider. What that means depends on the environment, and the dashboard
 * says which:
 *
 *   demo provider   -> a simulated booking (DEMO-… id, no courier)
 *   Borzo sandbox   -> a real Borzo test order: real order id, real
 *                      tracking page, no courier dispatched, no charge
 *   Borzo production-> refused. These addresses are illustrative, and a
 *                      sample must never send a real rider anywhere.
 *
 * Every sample is flagged isSample, named "Sample — …" and, for Borzo, uses
 * the shop's own phone as the drop-off contact with Borzo's SMS
 * notifications off — so no stranger's phone is ever contacted.
 *
 * Payment: a sample takes none. It is stored as AWAITING_PAYMENT like any
 * order, then marked paid with method "sample" (shown as such everywhere —
 * never counted as money collected) so it continues down the same path.
 */
const { getAllProducts } = require("./datastore");
const { createPendingOrder } = require("./placeOrder");
const { completePayment } = require("../payments");
const { getDeliveryProvider } = require("../delivery");
const { getNotificationProvider } = require("../notifications");

// Neighbourhoods around the Ghansoli kitchen that Borzo's Mumbai region
// covers. Building names are illustrative, not real customers.
const SAMPLE_CUSTOMERS = [
  {
    customer: { name: "Sample — Priya", phone: "9000000101" },
    address: { house: "Flat 302, Sample Residency", street: "Sector 7", area: "Ghansoli", city: "Navi Mumbai", pincode: "400701", landmark: "Near Ghansoli station" },
  },
  {
    customer: { name: "Sample — Rohan", phone: "9000000102" },
    address: { house: "B-14, Sample Heights", street: "Sector 19", area: "Kopar Khairane", city: "Navi Mumbai", pincode: "400709" },
  },
  {
    customer: { name: "Sample — Ananya", phone: "9000000103" },
    address: { house: "A-501, Sample Towers", street: "Sector 17", area: "Vashi", city: "Navi Mumbai", pincode: "400703", landmark: "Opp. Inorbit Mall" },
  },
  {
    customer: { name: "Sample — Kabir", phone: "9000000104" },
    address: { house: "Plot 22, Sample Enclave", street: "Sector 8", area: "Airoli", city: "Navi Mumbai", pincode: "400708" },
  },
  {
    customer: { name: "Sample — Meera", phone: "9000000105" },
    address: { house: "C-9, Sample Park", street: "Sector 21", area: "Nerul", city: "Navi Mumbai", pincode: "400706" },
  },
];

class SampleOrdersRefused extends Error {}

function pickItems(products, seed) {
  const simple = products.filter((p) => !p.variants && p.availability !== false);
  const pool = simple.length ? simple : products;
  const first = pool[seed % pool.length];
  const second = pool[(seed * 7 + 3) % pool.length];
  const items = [{ productId: first.productId, qty: 1 }];
  if (second && second.productId !== first.productId) items.push({ productId: second.productId, qty: 1 + (seed % 2) });
  return items;
}

async function createSampleOrders({ count = 1 } = {}) {
  const provider = getDeliveryProvider();
  if (provider.name === "borzo" && provider.environment === "production") {
    throw new SampleOrdersRefused(
      "Sample orders are disabled on Borzo production — they would dispatch real couriers to illustrative addresses and charge the wallet. Use BORZO_ENV=test."
    );
  }

  const products = getAllProducts();
  // Only the demo notification log is safe for samples; a live WhatsApp
  // account would message the owner about orders that don't exist.
  const notify = getNotificationProvider().name === "demo";
  const offset = Math.floor(Date.now() / 1000);
  const results = [];

  // One after another, not in parallel: it reads like a real queue of
  // orders in the dashboard and stays well inside Borzo's rate limits.
  for (let i = 0; i < count; i++) {
    const sample = SAMPLE_CUSTOMERS[(offset + i) % SAMPLE_CUSTOMERS.length];
    try {
      const { order: pending, deliveryQuote } = await createPendingOrder({
        customer: sample.customer,
        address: sample.address,
        items: pickItems(products, offset + i),
        paymentMethod: "sample",
        customerPhoneVerified: false,
        isSample: true,
      });
      const { order, deliveryPromise } = await completePayment(pending.orderId, { simulated: true, verifiedBy: "sample" }, { notify });
      const delivery = await deliveryPromise;
      results.push({
        ok: delivery.status !== "failed",
        orderId: order.orderId,
        token: order.token,
        area: sample.address.area,
        total: order.total,
        quoteRupees: deliveryQuote.feeRupees,
        delivery,
      });
    } catch (err) {
      results.push({ ok: false, area: sample.address.area, error: err.publicMessage || err.message });
    }
  }

  return {
    provider: provider.name,
    environment: provider.name === "borzo" ? provider.environment : "demo",
    results,
  };
}

module.exports = { createSampleOrders, SampleOrdersRefused, SAMPLE_CUSTOMERS };
