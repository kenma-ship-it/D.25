/**
 * Revenue figures for the owner dashboard (GET /api/admin/revenue).
 *
 * What counts as revenue:
 *   - Only orders whose payment the gateway confirmed (payment.status PAID,
 *     PARTIALLY_REFUNDED or REFUNDED), net of processed refunds on that
 *     payment. Unpaid, failed and cancelled orders never count. An extra
 *     (duplicate) charge isn't revenue — it's owed back — so it's excluded.
 *   - Orders from before online payments existed (no `payment`) count at
 *     their order total unless cancelled.
 *   - Once a real gateway is live, demo-payment orders are left out, so test
 *     orders never inflate real takings.
 * Dates are the payment time in India (Asia/Kolkata), so "today" matches the shop's day.
 */
const TZ = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

const dayKey = (d) => dayFmt.format(d); // YYYY-MM-DD
const monthKey = (d) => dayKey(d).slice(0, 7); // YYYY-MM
const yearKey = (d) => dayKey(d).slice(0, 4); // YYYY

/** One paid order -> { at, netPaise, refundsPaise, lines } or null if it doesn't count. */
function revenueOf(order, { liveProvider } = {}) {
  const p = order.payment;
  if (!p) {
    if (liveProvider || order.status === "CANCELLED") return null;
    return { at: new Date(order.createdAt), grossPaise: Math.round(Number(order.total) * 100), refundsPaise: 0, lines: order.lines || [] };
  }
  if (!["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status)) return null;
  if (liveProvider && p.provider !== liveProvider) return null;
  const gross = Number(p.amountPaidPaise || p.amountPaise) || 0;
  const refunds = (p.refunds || [])
    .filter((r) => r.status === "processed" && r.paymentId === p.paymentId)
    .reduce((sum, r) => sum + (Number(r.amountPaise) || 0), 0);
  return { at: new Date(p.paidAt || order.createdAt), grossPaise: gross, refundsPaise: Math.min(refunds, gross), lines: order.lines || [] };
}

function bucket() {
  return { revenuePaise: 0, refundsPaise: 0, orders: 0 };
}
function add(b, r) {
  const net = r.grossPaise - r.refundsPaise;
  b.revenuePaise += net;
  b.refundsPaise += r.refundsPaise;
  if (net > 0) b.orders += 1;
}

/** Calendar helpers on IST date keys (no DST in India, so a fixed +05:30 is exact). */
function istDate(key) {
  return new Date(`${key}T12:00:00+05:30`);
}
function shiftDays(key, n) {
  const d = istDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}
function shiftMonths(key, n) {
  const [y, m] = key.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

function topItems(rows, limit = 5) {
  const byName = new Map();
  for (const r of rows) {
    for (const l of r.lines) {
      const name = l.variantLabel ? `${l.name} (${l.variantLabel})` : l.name;
      const cur = byName.get(name) || { name, qty: 0, revenuePaise: 0 };
      cur.qty += Number(l.qty) || 0;
      cur.revenuePaise += Math.round((Number(l.lineTotal) || 0) * 100);
      byName.set(name, cur);
    }
  }
  return [...byName.values()].sort((a, b) => b.revenuePaise - a.revenuePaise || b.qty - a.qty).slice(0, limit);
}

/**
 * @param {object[]} orders
 * @param {{ now?: Date, liveProvider?: string|null, days?: number, months?: number }} opts
 */
function computeRevenue(orders, { now = new Date(), liveProvider = null, days = 30, months = 12 } = {}) {
  const rows = orders.map((o) => revenueOf(o, { liveProvider })).filter(Boolean);
  const today = dayKey(now);
  const thisMonth = today.slice(0, 7);
  const thisYear = today.slice(0, 4);

  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) daily.set(shiftDays(today, -i), bucket());
  const monthly = new Map();
  for (let i = months - 1; i >= 0; i--) monthly.set(shiftMonths(thisMonth, -i), bucket());
  const yearly = new Map();
  const firstYear = rows.length ? Math.min(...rows.map((r) => Number(yearKey(r.at)))) : Number(thisYear);
  for (let y = Math.min(firstYear, Number(thisYear)); y <= Number(thisYear); y++) yearly.set(String(y), bucket());

  const summary = {
    today: bucket(),
    yesterday: bucket(),
    thisMonth: bucket(),
    lastMonth: bucket(),
    thisYear: bucket(),
    lastYear: bucket(),
    // Fair comparisons for a period still in progress: the same days of the
    // previous month / the same dates of the previous year.
    lastMonthToDate: bucket(),
    lastYearToDate: bucket(),
  };
  const yesterday = shiftDays(today, -1);
  const lastMonth = shiftMonths(thisMonth, -1);
  const lastYear = String(Number(thisYear) - 1);
  const monthRows = [];
  const yearRows = [];

  for (const r of rows) {
    const d = dayKey(r.at);
    const m = d.slice(0, 7);
    const y = d.slice(0, 4);
    if (daily.has(d)) add(daily.get(d), r);
    if (monthly.has(m)) add(monthly.get(m), r);
    if (yearly.has(y)) add(yearly.get(y), r);
    if (d === today) add(summary.today, r);
    if (d === yesterday) add(summary.yesterday, r);
    if (m === thisMonth) {
      add(summary.thisMonth, r);
      monthRows.push(r);
    }
    if (m === lastMonth) {
      add(summary.lastMonth, r);
      if (d.slice(8) <= today.slice(8)) add(summary.lastMonthToDate, r);
    }
    if (y === thisYear) {
      add(summary.thisYear, r);
      yearRows.push(r);
    }
    if (y === lastYear) {
      add(summary.lastYear, r);
      if (d.slice(5) <= today.slice(5)) add(summary.lastYearToDate, r);
    }
  }

  const toList = (map) => [...map.entries()].map(([key, b]) => ({ key, ...b }));
  return {
    currency: "INR",
    timeZone: TZ,
    today,
    excludesDemo: Boolean(liveProvider),
    summary,
    daily: toList(daily),
    monthly: toList(monthly),
    yearly: toList(yearly),
    topItems: { thisMonth: topItems(monthRows), thisYear: topItems(yearRows) },
  };
}

module.exports = { computeRevenue, revenueOf, dayKey };
