#!/usr/bin/env node
// Performance roadmap P2 — budget gate.
//
// Reads the Criterion output produced by `cargo bench -p clippity-bench`
// and compares each automated metric's *median* against the warn/fail
// bands in `app/backend/benches-budgets.json`. Exit code:
//   0  every automated metric within its warn band (warnings still print)
//   1  at least one metric over its fail band, or its result is missing
//
// Non-automated metrics (startup, overlay, OCR, idle CPU/RAM, installer
// size) are listed in the manifest for the record but skipped here — they
// need a running app or a model on disk and a native driver that does not
// exist yet. They print as "tracked (manual)" so the gap stays visible.
//
// Usage:
//   node scripts/check-bench-budgets.mjs
//   node scripts/check-bench-budgets.mjs --criterion-dir <dir> --budgets <file>

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const budgetsPath = arg("--budgets", join(repoRoot, "app/backend/benches-budgets.json"));
const criterionDir = arg("--criterion-dir", join(repoRoot, "app/backend/target/criterion"));

if (!existsSync(budgetsPath)) {
  console.error(`budgets manifest not found: ${budgetsPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(budgetsPath, "utf8"));
const metrics = manifest.metrics ?? {};

/** Median for a Criterion metric key "group/function", in ms, or null. */
function medianMs(key) {
  const parts = key.split("/");
  const estimates = join(criterionDir, ...parts, "new", "estimates.json");
  if (!existsSync(estimates)) return null;
  const json = JSON.parse(readFileSync(estimates, "utf8"));
  const ns = json?.median?.point_estimate;
  return typeof ns === "number" ? ns / 1e6 : null;
}

const rows = [];
let failed = 0;
let warned = 0;
let missing = 0;

for (const [key, spec] of Object.entries(metrics)) {
  if (!spec.automated) {
    rows.push({ key, status: "manual", detail: budgetText(spec) });
    continue;
  }
  const ms = medianMs(key);
  if (ms === null) {
    missing += 1;
    rows.push({ key, status: "MISSING", detail: "no criterion result — run the bench first" });
    continue;
  }
  const value = `${ms.toFixed(2)} ms`;
  if (spec.fail_ms != null && ms > spec.fail_ms) {
    failed += 1;
    rows.push({ key, status: "FAIL", detail: `${value} > fail ${spec.fail_ms} ms` });
  } else if (spec.warn_ms != null && ms > spec.warn_ms) {
    warned += 1;
    rows.push({ key, status: "warn", detail: `${value} > warn ${spec.warn_ms} ms` });
  } else {
    rows.push({ key, status: "ok", detail: `${value} (warn ${spec.warn_ms} / fail ${spec.fail_ms} ms)` });
  }
}

function budgetText(spec) {
  if (spec.target_ms != null) return `target ${spec.target_ms} ms`;
  if (spec.target_bytes != null) return `target ${(spec.target_bytes / 1e6).toFixed(0)} MB`;
  return spec.note ?? "tracked";
}

const width = Math.max(...rows.map((r) => r.key.length), 8);
console.log("");
console.log("Clippity performance budgets (roadmap P2)");
console.log("=".repeat(width + 40));
for (const r of rows) {
  const tag = r.status.padEnd(8);
  console.log(`${tag} ${r.key.padEnd(width)}  ${r.detail}`);
}
console.log("=".repeat(width + 40));
console.log(
  `automated: ${failed} fail, ${warned} warn, ${missing} missing; manual tracked: ` +
    `${rows.filter((r) => r.status === "manual").length}`,
);

if (missing > 0 || failed > 0) process.exit(1);
