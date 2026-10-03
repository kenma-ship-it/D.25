/**
 * Keeps every open Borzo delivery in step with Borzo: one batched
 * GET /orders call for all of them every BORZO_SYNC_MS (default 20s).
 *
 * Polling rather than Borzo's callback webhook because a callback needs a
 * public HTTPS URL, which a laptop demo doesn't have; the batched call keeps
 * it to one request per interval however many orders are open.
 *
 * The courier's progress also moves the kitchen status, forward only:
 * courier picked up -> OUT_FOR_DELIVERY, delivered -> DELIVERED. It never
 * moves an order backwards or past what the kitchen has already set.
 */
const { getDeliveryProvider } = require("./index");
const { getAllOrders, setDelivery, setStatus } = require("../lib/orders");

const KITCHEN_STATUSES = [
  "ORDER_PLACED",
  "PAYMENT_CONFIRMED",
  "PREPARING",
  "READY_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];
const COURIER_TO_KITCHEN = { picked_up: "OUT_FOR_DELIVERY", delivered: "DELIVERED" };
const FINISHED = new Set(["delivered", "cancelled"]);

let inFlight = null;
let lastRun = null;

function isOpenBorzoDelivery(order, environment) {
  const d = order.delivery;
  return Boolean(d && d.provider === "borzo" && d.deliveryOrderId && d.environment === environment && !FINISHED.has(d.status));
}

async function runSync() {
  const provider = getDeliveryProvider();
  if (provider.name !== "borzo") return { skipped: "Borzo is not the active delivery provider", checked: 0, updated: 0 };

  const open = (await getAllOrders()).filter((o) => isOpenBorzoDelivery(o, provider.environment));
  if (!open.length) return { checked: 0, updated: 0 };

  const byId = await provider.getDeliveryStatuses(open.map((o) => o.delivery.deliveryOrderId));
  const now = new Date().toISOString();
  let updated = 0;

  for (const order of open) {
    const fresh = byId[String(order.delivery.deliveryOrderId)];
    if (!fresh) continue;
    const changed = fresh.borzoStatus !== order.delivery.borzoStatus || fresh.status !== order.delivery.status;
    await setDelivery(order.orderId, { ...order.delivery, ...fresh, createdAt: order.delivery.createdAt, lastSyncedAt: now, error: null });
    if (changed) updated++;

    const target = COURIER_TO_KITCHEN[fresh.status];
    if (target && KITCHEN_STATUSES.indexOf(target) > KITCHEN_STATUSES.indexOf(order.status)) {
      await setStatus(order.orderId, target);
    }
  }
  return { checked: open.length, updated };
}

/** Runs one sync; concurrent callers share the run already in progress. */
async function syncBorzoDeliveries() {
  if (!inFlight) {
    inFlight = runSync()
      .then((result) => {
        lastRun = { at: new Date().toISOString(), ...result, error: null };
        return lastRun;
      })
      .catch((err) => {
        lastRun = { at: new Date().toISOString(), checked: 0, updated: 0, error: err.message };
        return lastRun;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

function startBorzoSync({ intervalMs = Number(process.env.BORZO_SYNC_MS) || 20000 } = {}) {
  const timer = setInterval(() => {
    syncBorzoDeliveries().then((r) => {
      // eslint-disable-next-line no-console
      if (r.error) console.error("[borzo-sync] status sync failed:", r.error);
    });
  }, Math.max(5000, intervalMs));
  if (timer.unref) timer.unref();
  return timer;
}

function lastSync() {
  return lastRun;
}

module.exports = { syncBorzoDeliveries, startBorzoSync, lastSync };
