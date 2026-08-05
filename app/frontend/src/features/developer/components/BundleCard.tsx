/**
 * The diagnostics bundle — what goes in it, and where it went.
 *
 * A bundle is made to be sent to somebody else, which is why redaction
 * is on by default and why the export writes a **folder** the user can
 * look inside before attaching anything. Nothing is transmitted: the
 * app writes files and opens the folder; sending them is the user's
 * action, in their own mail client.
 */

import { useState } from "react";
import { FolderOpen, Package } from "lucide-react";

import {
  exportDiagnosticsBundle,
  openFolder,
  type BundleOptions,
  type BundleResult,
} from "@services/tauri/clients/developer";
import { Button, ToggleSwitch } from "@shared/ui";
import { Row } from "@features/settings/components/Row";
import { SectionCard } from "@features/settings/components/SectionCard";

import { formatBytes } from "../lib/format";
import { ActionRow } from "./DevRow";

interface BundleCardProps {
  /** Seeded from `developer.redactDiagnostics`; the card owns the rest
   *  of the options for the duration of the page, because they describe
   *  one export rather than a standing preference. */
  redactByDefault: boolean;
  onRedactChange(next: boolean): void;
}

export function BundleCard({
  redactByDefault,
  onRedactChange,
}: BundleCardProps) {
  const [options, setOptions] = useState<Omit<BundleOptions, "redactPaths">>({
    redactCaptureNames: true,
    includeLogs: true,
    includeSettings: true,
  });
  const [result, setResult] = useState<BundleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportBundle = () => {
    setBusy(true);
    setError(null);
    void exportDiagnosticsBundle({ ...options, redactPaths: redactByDefault })
      .then(setResult)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(false));
  };

  return (
    <SectionCard title="Diagnostics bundle">
      <Row
        label="Remove personal information"
        description="Replace your account name and home folder with placeholders in every file."
        control={
          <ToggleSwitch
            checked={redactByDefault}
            onChange={onRedactChange}
            label="Remove personal information"
          />
        }
      />
      <Row
        label="Remove capture file names"
        description="Capture names come from the window they were taken in, which makes them the most identifying string the app writes."
        control={
          <ToggleSwitch
            checked={options.redactCaptureNames}
            onChange={(redactCaptureNames) =>
              setOptions((o) => ({ ...o, redactCaptureNames }))
            }
            label="Remove capture file names"
          />
        }
      />
      <Row
        label="Include logs"
        description="The retained log files, redacted with everything else. Without them a bundle is a settings dump."
        control={
          <ToggleSwitch
            checked={options.includeLogs}
            onChange={(includeLogs) =>
              setOptions((o) => ({ ...o, includeLogs }))
            }
            label="Include logs"
          />
        }
      />
      <Row
        label="Include settings"
        description="Your persisted settings.json."
        control={
          <ToggleSwitch
            checked={options.includeSettings}
            onChange={(includeSettings) =>
              setOptions((o) => ({ ...o, includeSettings }))
            }
            label="Include settings"
          />
        }
      />

      <ActionRow
        label="Export bundle"
        description="Writes a folder you can inspect before sending it. Captures, clipboard contents and account details are never included."
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void openFolder("bundles")}
        >
          <FolderOpen size={13} strokeWidth={2} />
          Open folder
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={exportBundle}
          disabled={busy}
        >
          <Package size={13} strokeWidth={2} />
          {busy ? "Exporting…" : "Export"}
        </Button>
      </ActionRow>

      {error && (
        <p className="px-5 pb-3 text-[12px] text-[var(--color-accent)]">
          Export failed: {error}
        </p>
      )}

      {result && !error && (
        <div className="px-5 pb-4">
          <p className="text-[12px] text-[var(--color-slate)]">
            {result.files.length} file{result.files.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(result.bytes)} ·{" "}
            {result.redacted ? "redacted" : "not redacted"}
          </p>
          <p className="mt-1 font-mono text-[11.5px] break-all text-[var(--color-ink)]">
            {result.path}
          </p>
          <ul className="mt-1 font-mono text-[11px] text-[var(--color-hint)]">
            {result.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
