#!/usr/bin/env node
// Stages the two public release artifacts and their SHA-256 checksum file.
// Run only after `pnpm dist`; inputs are the collected application/installer
// outputs, while build/release is recreated to prevent stale uploads.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Stream a file through SHA-256 without holding it in memory. */
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appConfig = JSON.parse(
  await readFile(
    join(root, "app", "backend", "src-tauri", "tauri.conf.json"),
    "utf8",
  ),
);
const installerConfig = JSON.parse(
  await readFile(
    join(root, "installer", "app", "backend", "src-tauri", "tauri.conf.json"),
    "utf8",
  ),
);

if (appConfig.version !== installerConfig.version) {
  throw new Error(
    `Version mismatch: app ${appConfig.version}, installer ${installerConfig.version}`,
  );
}

const version = appConfig.version;
const releaseDir = join(root, "build", "release");
const artifacts = [
  {
    source: join(root, "installer", "build", "Clippity Setup.exe"),
    name: `Clippity-${version}-Setup.exe`,
  },
  {
    source: join(root, "build", "portable", `Clippity-${version}-portable.zip`),
    name: `Clippity-${version}-portable.zip`,
  },
];

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const checksumLines = [];
for (const artifact of artifacts) {
  const info = await stat(artifact.source).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`Missing release input: ${artifact.source}`);
  }
  const [digest] = await Promise.all([
    sha256(artifact.source),
    copyFile(artifact.source, join(releaseDir, artifact.name)),
  ]);
  checksumLines.push(`${digest}  ${artifact.name}`);
  console.log(`${artifact.name}  ${info.size} bytes  sha256:${digest}`);
}

await writeFile(
  join(releaseDir, "SHA256SUMS.txt"),
  `${checksumLines.join("\r\n")}\r\n`,
  "utf8",
);
console.log(`Release files staged in ${releaseDir}`);
