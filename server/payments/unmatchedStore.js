/**
 * Payments the gateway reported that can't be tied to any DE.25 order —
 * e.g. a payment on a gateway order we have no record of. Money was taken,
 * so the owner must see it (and usually refund it). Kept apart from orders
 * because there is no order to attach it to.
 *
 * Storage follows the order store: Supabase table `payment_issues` when
 * SUPABASE_ORDERS_ENABLED=true (see supabase/schema.sql), otherwise
 * data/payment-issues.json (gitignored — contains payment references).
 */
const fs = require("fs");
const path = require("path");
const { restRequest } = require("../lib/supabaseRest");

const FILE = path.join(__dirname, "..", "..", "data", "payment-issues.json");
const TABLE = "payment_issues";

function useSupabase() {
  return (
    String(process.env.SUPABASE_ORDERS_ENABLED || "false").toLowerCase() === "true" &&
    Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

function readFile() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch (_e) {
    return [];
  }
}
function writeFile(list) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[payments] failed to write payment-issues.json:", err.message);
  }
}

/** Records a payment with no matching order. Idempotent per paymentId. */
async function recordUnmatched(payment, source) {
  const entry = {
    paymentId: payment.paymentId,
    gatewayOrderId: payment.gatewayOrderId || null,
    status: payment.status,
    amountPaise: payment.amountPaise,
    method: payment.method || null,
    source,
    seenAt: new Date().toISOString(),
    resolved: false,
  };
  if (useSupabase()) {
    await restRequest(TABLE, {
      method: "POST",
      query: { on_conflict: "payment_id" },
      body: {
        payment_id: entry.paymentId,
        gateway_order_id: entry.gatewayOrderId,
        status: entry.status,
        amount_paise: entry.amountPaise,
        method: entry.method,
        source: entry.source,
        seen_at: entry.seenAt,
      },
      prefer: "resolution=ignore-duplicates",
    });
    return entry;
  }
  const list = readFile();
  const existing = list.find((e) => e.paymentId === entry.paymentId);
  if (existing) {
    existing.status = entry.status;
  } else {
    list.unshift(entry);
  }
  writeFile(list.slice(0, 500));
  return existing || entry;
}

async function listUnmatched({ includeResolved = false } = {}) {
  if (useSupabase()) {
    const query = { select: "*", order: "seen_at.desc", limit: "200" };
    if (!includeResolved) query.resolved = "eq.false";
    const rows = (await restRequest(TABLE, { query })) || [];
    return rows.map((r) => ({
      paymentId: r.payment_id,
      gatewayOrderId: r.gateway_order_id,
      status: r.status,
      amountPaise: Number(r.amount_paise),
      method: r.method,
      source: r.source,
      seenAt: r.seen_at,
      resolved: r.resolved,
    }));
  }
  return readFile().filter((e) => includeResolved || !e.resolved);
}

async function resolveUnmatched(paymentId) {
  if (useSupabase()) {
    await restRequest(TABLE, { method: "PATCH", query: { payment_id: `eq.${paymentId}` }, body: { resolved: true } });
    return true;
  }
  const list = readFile();
  const entry = list.find((e) => e.paymentId === paymentId);
  if (!entry) return false;
  entry.resolved = true;
  writeFile(list);
  return true;
}

module.exports = { recordUnmatched, listUnmatched, resolveUnmatched, UNMATCHED_FILE: FILE };
