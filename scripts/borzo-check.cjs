#!/usr/bin/env node
/**
 * Live Borzo connection check from the command line — the same real
 * calculate-order request to both Borzo hosts as the owner dashboard's
 * "Run live connection check" button (server/delivery/borzoConnectionCheck.js).
 * A price check only: it never books a courier.
 *
 * Run with: npm run borzo:check
 *
 * Exit code 0 when every Borzo host answered, 1 when any was unreachable.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { runConnectionCheck } = require("../server/delivery/borzoConnectionCheck");
const { resolveBorzoConfig } = require("../server/delivery/borzoConfig");

async function main() {
  const cfg = resolveBorzoConfig();
  console.log(`Borzo connection check — ${new Date().toISOString()}`);
  console.log(`Configured environment: ${cfg.environment}  ·  token: ${cfg.hasToken ? "set" : "not set"}  ·  active: ${cfg.active ? "yes" : "no"}`);
  if (!cfg.active) console.log(`Borzo is not the active provider: ${cfg.problems.join("; ")}`);
  console.log("");

  const result = await runConnectionCheck();
  for (const h of result.hosts) {
    console.log(`${h.environment.padEnd(10)} ${h.host}`);
    console.log(`           HTTP ${h.httpStatus || "—"} in ${h.latencyMs} ms  ·  ${h.authenticated ? "with token" : "no token sent"}`);
    if (h.errors.length) console.log(`           Borzo errors: ${h.errors.join(", ")}`);
    console.log(`           ${h.verdict}`);
    console.log("");
  }

  process.exitCode = result.hosts.every((h) => h.reachable) ? 0 : 1;
}

main().catch((err) => {
  console.error("Connection check failed:", err.message);
  process.exitCode = 1;
});
