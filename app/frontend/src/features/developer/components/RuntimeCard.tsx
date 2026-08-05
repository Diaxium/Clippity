/**
 * Windows, the global hotkey, and storage — the "why is nothing
 * happening?" card, plus the destructive corner that clears caches and
 * rebuilds the library index.
 *
 * The three complaints this exists for: the capture hotkey silently
 * stopped working (another app took the registration), a window is up
 * that shouldn't be, and screenshots contain Clippity's own chrome (the
 * capture shield failed to apply).
 */

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  clearCache,
  openFolder,
  type CacheTarget,
  type FolderTarget,
  type RuntimeStatus,
} from "@services/tauri/clients/developer";
import { libraryReindex } from "@services/tauri/clients/library";
import { Button } from "@shared/ui";
import { SectionCard } from "@features/settings/components/SectionCard";

import { formatBytes } from "../lib/format";
import { ActionRow, DangerButton, ResultNote, StatLine } from "./DevRow";

/** The caches a developer may clear, with what each one costs to lose. */
const CACHES: ReadonlyArray<{
  target: CacheTarget;
  label: string;
  description: string;
  confirmLabel: string;
}> = [
  {
    target: "thumbnails",
    label: "Thumbnail cache",
    description: "Library previews. Regenerated as items come back into view.",
    confirmLabel: "Delete thumbnails",
  },
  {
    target: "temp",
    label: "Temporary files",
    description: "Scratch files from exports and staging.",
    confirmLabel: "Delete temp files",
  },
  {
    target: "webview",
    label: "WebView cache",
    description:
      "The WebView2 profile for this app. Takes effect after a restart.",
    confirmLabel: "Delete WebView cache",
  },
  {
    target: "models",
    label: "Downloaded models",
    description:
      "Every installed AI model. They have to be downloaded again before object detection or OCR will run.",
    confirmLabel: "Delete all models",
  },
];

/** The folders the page can open. */
const FOLDERS: ReadonlyArray<{ target: FolderTarget; label: string }> = [
  { target: "data", label: "App data" },
  { target: "captures", label: "Captures" },
  { target: "logs", label: "Logs" },
  { target: "bundles", label: "Diagnostics" },
  { target: "install", label: "Install" },
];

interface RuntimeCardProps {
  status: RuntimeStatus | null;
  confirmDestructive: boolean;
  onRefresh: () => void;
}

export function RuntimeCard({
  status,
  confirmDestructive,
  onRefresh,
}: RuntimeCardProps) {
  const [note, setNote] = useState<string | null>(null);

  const run = (label: string, work: Promise<number | string | void>) => {
    void work.then(
      (result) =>
        setNote(
          typeof result === "number"
            ? `${label}: freed ${formatBytes(result)}.`
            : `${label}: done.`
        ),
      (err: unknown) =>
        setNote(
          `${label} failed: ${err instanceof Error ? err.message : String(err)}`
        )
    );
  };

  return (
    <>
      <SectionCard title="Windows, shortcuts and storage">
        <ActionRow
          label="Live state"
          description="Registered windows, the capture shield, and what the OS actually holds for the global hotkey."
        >
          <Button variant="secondary" size="sm" onClick={onRefresh}>
            <RefreshCw size={13} strokeWidth={2} />
            Refresh
          </Button>
        </ActionRow>

        {status && (
          <div className="py-2">
            <StatLine
              label="Global capture hotkey"
              value={
                status.globalCapture.registered
                  ? `${status.globalCapture.combo} — registered`
                  : `${status.globalCapture.combo || "none"} — ${
                      status.globalCapture.detail ?? "not registered"
                    }`
              }
              tone={status.globalCapture.registered ? "normal" : "warn"}
            />
            {!status.globalHotkeysInstalled && (
              <StatLine
                label="Capture integration"
                value="not installed — no global hotkey is registered"
                tone="warn"
              />
            )}
            <StatLine
              label="Capture shield"
              value={
                status.captureShielded
                  ? "on — Clippity's windows are excluded from captures"
                  : "off — Clippity's windows can appear in a capture"
              }
              tone={status.captureShielded ? "normal" : "warn"}
            />
            <StatLine
              label="Library index"
              value={formatBytes(status.libraryDbBytes)}
            />
            <StatLine
              label="Cache on disk"
              value={formatBytes(status.cacheBytes)}
            />
          </div>
        )}

        {status && (
          <div className="py-2">
            <p className="px-5 pt-1 pb-1 text-[12px] font-medium text-[var(--color-ink)]">
              Windows
            </p>
            {status.windows.map((window) => (
              <StatLine
                key={window.label}
                label={window.label}
                value={`${window.visible ? "visible" : "hidden"}${
                  window.focused ? " · focused" : ""
                } · ${window.width}×${window.height} at (${window.x}, ${window.y})`}
              />
            ))}
          </div>
        )}

        <ActionRow label="Open a folder" description="In the OS file manager.">
          <div className="flex flex-wrap justify-end gap-2">
            {FOLDERS.map(({ target, label }) => (
              <Button
                key={target}
                variant="secondary"
                size="sm"
                onClick={() =>
                  void openFolder(target).catch((err: unknown) =>
                    setNote(
                      `Could not open ${label}: ${
                        err instanceof Error ? err.message : String(err)
                      }`
                    )
                  )
                }
              >
                {label}
              </Button>
            ))}
          </div>
        </ActionRow>
      </SectionCard>

      <SectionCard title="Caches and index">
        {CACHES.map((cache) => (
          <ActionRow
            key={cache.target}
            label={cache.label}
            description={cache.description}
          >
            <DangerButton
              label="Clear"
              confirmLabel={cache.confirmLabel}
              confirm={confirmDestructive}
              onConfirm={() =>
                run(
                  `Cleared the ${cache.label.toLowerCase()}`,
                  clearCache(cache.target)
                )
              }
            />
          </ActionRow>
        ))}
        <ActionRow
          label="Rebuild library index"
          description="Re-reads every capture and its sidecar. Safe — the index is a cache over the files, never the source of truth."
        >
          <DangerButton
            label="Rebuild"
            confirmLabel="Rebuild the index"
            confirm={confirmDestructive}
            onConfirm={() => {
              void libraryReindex().then(
                () => {
                  setNote("Library index rebuilt.");
                  onRefresh();
                },
                (err: unknown) =>
                  setNote(
                    `Rebuild failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  )
              );
            }}
          />
        </ActionRow>
        <ResultNote>{note}</ResultNote>
      </SectionCard>
    </>
  );
}
