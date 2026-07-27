#!/usr/bin/env node
// Collects the built Tauri application files into <root>/build.
//
// Tauri always emits its bundles under the Cargo target directory
// (app/backend/target/<profile>/bundle/), with no config knob to redirect
// just the final artifacts. This script runs after `tauri build` and copies
// the finished installers and the standalone executable into a single
// top-level `build/` folder so distributables live in one predictable place.

import { cp, mkdir, rm, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

// Allow `--profile debug` (defaults to release, which is what tauri:build uses).
const profileArg = process.argv.indexOf("--profile");
const profile = profileArg !== -1 ? process.argv[profileArg + 1] : "release";

const targetDir = join(root, "app", "backend", "target", profile);
const bundleDir = join(targetDir, "bundle");
const outDir = join(root, "build");

const exists = async (p) =>
  access(p, constants.F_OK).then(
    () => true,
    () => false,
  );

async function main() {
  if (!(await exists(bundleDir))) {
    console.error(
      `[collect-build] No bundle output found at ${bundleDir}.\n` +
        `Run \`pnpm tauri:build\` first (nothing to collect).`,
    );
    process.exit(1);
  }

  // Start from a clean build/ so stale artifacts never linger.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // Copy each bundle type (msi/, nsis/, …) preserving structure. Keeping the
  // subfolders avoids name collisions between installers and their updater
  // sidecar files (.nsis.zip, .sig).
  const bundleTypes = await readdir(bundleDir, { withFileTypes: true });
  const copied = [];
  for (const entry of bundleTypes) {
    if (!entry.isDirectory()) continue;
    const src = join(bundleDir, entry.name);
    const dest = join(outDir, entry.name);
    await cp(src, dest, { recursive: true });
    copied.push(entry.name + "/");
  }

  // Also include the standalone application binary next to the installers.
  for (const exe of ["clippity.exe", "clippity"]) {
    const src = join(targetDir, exe);
    if (await exists(src)) {
      await cp(src, join(outDir, exe));
      copied.push(exe);
      break;
    }
  }

  console.log(
    `[collect-build] Copied to build/: ${copied.join(", ") || "(nothing)"}`,
  );
}

main().catch((err) => {
  console.error("[collect-build] Failed:", err);
  process.exit(1);
});
