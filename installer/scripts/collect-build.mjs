#!/usr/bin/env node
// Collects the built installer into <installer>/build as a single
// self-contained `Clippity Setup.exe`.
//
// Unlike the app, this project does no Tauri bundling (`bundle.active` is
// false): the Clippity payload is compiled into the binary by
// crates/services/build.rs, so `tauri build` emits one executable that
// needs nothing beside it. Wrapping that in an msi or nsis package would
// only produce an installer for the installer.
//
// All this script does, then, is lift that binary out of the Cargo target
// directory and give it the name users should see.

import { cp, mkdir, rm, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

// Allow `--profile debug` (defaults to release, which is what tauri:build uses).
const profileArg = process.argv.indexOf("--profile");
const profile = profileArg !== -1 ? process.argv[profileArg + 1] : "release";

const targetDir = join(root, "app", "backend", "target", profile);
const outDir = join(root, "build");

/// The name handed to users. Tauri emits the Cargo package name; the
/// candidates cover the productName variant across Tauri versions.
const SHIPPED_NAME = "Clippity Setup.exe";
const CANDIDATES = [
  "clippity-installer.exe",
  "clippity-installer",
  "Clippity Setup.exe",
];

const exists = async (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

async function main() {
  let built = null;
  for (const name of CANDIDATES) {
    const candidate = join(targetDir, name);
    if (await exists(candidate)) {
      built = candidate;
      break;
    }
  }

  if (!built) {
    console.error(
      `[collect-build] No installer binary found in ${targetDir}.\n` +
        `Run \`pnpm tauri:build\` first (nothing to collect).`,
    );
    process.exit(1);
  }

  // Start from a clean build/ so stale artifacts never linger.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const shipped = join(outDir, SHIPPED_NAME);
  await cp(built, shipped);

  const { size } = await stat(shipped);
  const mb = (size / 1_000_000).toFixed(1);

  // A setup binary that doesn't carry the ~40 MB app is the signature of
  // a build that skipped staging. Worth saying out loud here rather than
  // letting it surface as a failed install later.
  const PAYLOAD_FLOOR_BYTES = 30_000_000;
  if (size < PAYLOAD_FLOOR_BYTES) {
    console.warn(
      `[collect-build] WARNING: ${SHIPPED_NAME} is only ${mb} MB — too small ` +
        `to contain the application. It was probably built without a staged ` +
        `payload; run \`pnpm dist\` from the app root.`,
    );
  }

  console.log(`[collect-build] Built build/${SHIPPED_NAME} (${mb} MB)`);
}

main().catch((err) => {
  console.error("[collect-build] Failed:", err);
  process.exit(1);
});
