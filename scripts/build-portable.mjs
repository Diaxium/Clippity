#!/usr/bin/env node
// Assembles the portable distribution of Clippity.
//
// A portable build is the same binary as the installed one — the only
// difference is the `Clippity.portable` marker file sitting next to it,
// which `clippity_infra::paths::portable_root` looks for. With the marker
// present the app keeps settings, the library database, captures, caches,
// and the WebView2 profile in a `Data` folder beside the executable, so
// the whole thing runs from a USB stick and leaves nothing behind.
//
// Runs after `pnpm tauri:build` (which fills build/) and produces both a
// ready-to-run folder and a zip to hand out.

import { cp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

const sourceExe = join(root, "build", "clippity.exe");
const outRoot = join(root, "build", "portable");

/** Zip `dir` into `zipPath` using the PowerShell archive cmdlet. */
async function zip(dir, zipPath) {
  await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`,
  ]);
}

async function main() {
  const info = await stat(sourceExe).catch(() => null);
  if (!info) {
    console.error(
      `[portable] No application binary at ${sourceExe}.\n` +
        `Run \`pnpm tauri:build\` first.`,
    );
    process.exit(1);
  }

  const appConf = JSON.parse(
    await readFile(
      join(root, "app", "backend", "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  );
  const version = appConf.version;

  // The folder name is what the user sees after extracting, so it carries
  // the version rather than relying on the zip's name surviving a copy.
  const folderName = `Clippity-${version}-portable`;
  const stageDir = join(outRoot, folderName);
  const zipPath = join(outRoot, `${folderName}.zip`);

  await rm(outRoot, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  await cp(sourceExe, join(stageDir, "Clippity.exe"));

  // The marker's contents are never read — only its presence matters —
  // so use it to explain itself to anyone who opens the folder.
  await writeFile(
    join(stageDir, "Clippity.portable"),
    [
      "Deleting this file turns portable mode off.",
      "",
      "While it is here, Clippity keeps everything it saves — settings,",
      "your library, captures, caches, and its browser profile — in the",
      "Data folder next to Clippity.exe.",
      "",
      "Move this whole folder wherever you like; your data travels with it.",
      "",
    ].join("\r\n"),
  );

  await writeFile(
    join(stageDir, "README.txt"),
    [
      `Clippity ${version} (portable)`,
      "",
      "Run Clippity.exe — there is nothing to install.",
      "",
      "Everything Clippity saves goes in the Data folder beside the",
      "executable, so you can run this from a USB stick and take it",
      "between machines. Delete the folder to remove Clippity: it adds",
      "no registry entries and no shortcuts.",
      "",
      "Requires the Microsoft Edge WebView2 runtime, which ships with",
      "Windows 11 and current Windows 10. That runtime is part of the",
      "system, not of this folder.",
      "",
      "To switch to a normal install instead, delete Clippity.portable",
      "or run the Clippity Setup installer.",
      "",
    ].join("\r\n"),
  );

  await zip(stageDir, zipPath);

  const zipInfo = await stat(zipPath);
  console.log(
    `[portable] Built ${folderName} — folder + zip ` +
      `(${(zipInfo.size / 1_000_000).toFixed(1)} MB) in build/portable/`,
  );
}

main().catch((err) => {
  console.error("[portable] Failed:", err);
  process.exit(1);
});
