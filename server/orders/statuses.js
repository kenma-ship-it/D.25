/**
 * Order statuses, shared by both order stores.
 *
 *   AWAITING_PAYMENT -> ORDER_PLACED ... DELIVERED   (the kitchen flow)
 *   AWAITING_PAYMENT -> CANCELLED                    (never paid in time)
 *
 * Every order starts in AWAITING_PAYMENT and only leaves it through a
 * confirmed payment (server/payments) — nothing is cooked, no courier is
 * booked and no one is notified before that. STATUSES is the kitchen flow
 * that advanceStatus() and the demo timer walk; an unpaid or cancelled
 * order is outside it, so neither can move one forward by accident.
 */
const STATUSES = [
  "ORDER_PLACED",
  "PAYMENT_CONFIRMED",
  "PREPARING",
  "READY_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

const AWAITING_PAYMENT = "AWAITING_PAYMENT";
const CANCELLED = "CANCELLED";

const ALL_STATUSES = [AWAITING_PAYMENT, ...STATUSES, CANCELLED];

module.exports = { STATUSES, AWAITING_PAYMENT, CANCELLED, ALL_STATUSES };
