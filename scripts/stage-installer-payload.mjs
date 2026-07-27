#!/usr/bin/env node
// Stages the built Clippity application as the custom installer's payload.
//
// The installer (installer/) is a separate workspace that ships the app
// *inside its own binary*: `crates/services/build.rs` compiles whatever
// lands here straight into the executable with `include_bytes!`, which is
// what makes the shipped `Clippity Setup.exe` a single self-contained
// file. Nothing else moves files between the two projects, so this script
// is the single seam — it must run after `pnpm tauri:build` (which fills
// build/) and before `pnpm installer:build`.
//
// Alongside the executable it writes payload.json, which the Rust side
// reads to know what to install, how big it is, and what hash to expect.
// The hash is what turns the wizard's "Verifying" step into a real check.

import { cp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

// Source: the standalone binary collect-build.mjs drops into build/.
const sourceExe = join(root, "build", "clippity.exe");

// Destination: the installer project's payload folder, which its Cargo
// build script compiles in. Named with the capital C the app ships under,
// since this is the exact file that lands in the install directory (and
// the name the shortcut + Add/Remove Programs entries already point at).
const payloadDir = join(root, "installer", "payload");
const payloadExe = join(payloadDir, "Clippity.exe");
const manifestFile = join(payloadDir, "payload.json");

/** Stream a file through SHA-256 without holding it in memory. */
function sha256(file) {
  return new Promise((ok, fail) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", fail)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => ok(hash.digest("hex")));
  });
}

async function main() {
  const info = await stat(sourceExe).catch(() => null);
  if (!info) {
    console.error(
      `[stage-payload] No application binary at ${sourceExe}.\n` +
        `Run \`pnpm tauri:build\` first — the installer has nothing to bundle.`,
    );
    process.exit(1);
  }

  // Read the app's version from its Tauri config so the payload manifest
  // can't drift from the binary sitting next to it.
  const appConf = JSON.parse(
    await readFile(
      join(root, "app", "backend", "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  );

  // Clear the staged files so a stale binary can never survive a failed
  // copy and get compiled in. The folder's README is deliberately kept —
  // it documents the folder for anyone who opens it.
  await mkdir(payloadDir, { recursive: true });
  await rm(payloadExe, { force: true });
  await rm(manifestFile, { force: true });
  await cp(sourceExe, payloadExe);

  const digest = await sha256(payloadExe);
  const manifest = {
    exe: "Clippity.exe",
    version: appConf.version,
    bytes: info.size,
    sha256: digest,
  };
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const mb = (info.size / 1_000_000).toFixed(1);
  console.log(
    `[stage-payload] Staged Clippity ${manifest.version} (${mb} MB) → installer/payload/`,
  );
}

main().catch((err) => {
  console.error("[stage-payload] Failed:", err);
  process.exit(1);
});
