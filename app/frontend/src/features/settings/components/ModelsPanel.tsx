import type { ReactNode } from "react";
import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";

import {
  modelsCancelDownload,
  modelsDownload,
  modelsRemove,
  modelsUpdate,
  type ModelInfo,
  type ReleaseCheck,
} from "@services/tauri/clients/models";
import { cn } from "@shared/lib/cn";
import { TickedSlider, ToggleSwitch, TrackTicks } from "@shared/ui";

import {
  CONFIDENCE_MAX_PCT,
  CONFIDENCE_MIN_PCT,
  CONFIDENCE_STEP_PCT,
  CONFIDENCE_TICK_STEP_PCT,
} from "../constants";
import { useModels, useReleaseChecks } from "../hooks/useModels";
import type { ModelsSettings } from "../types";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

/** True when the live release check says a newer published release exists
 *  for an installed model AND we can actually fetch it. Drives the live
 *  "Update" affordance, distinct from the compile-time `update-available`
 *  phase (which only knows releases baked into this build). */
function hasLiveUpdate(check: ReleaseCheck | undefined): boolean {
  return (
    !!check && check.installed && check.updatable && !check.installedIsLatest
  );
}

interface ModelsPanelProps {
  value: ModelsSettings;
  onChange(next: ModelsSettings): void;
}

/**
 * Settings → Models. Two concerns:
 *
 * 1. **Behaviour** — auto-download policy, which detector backs the
 *    Object capture mode, and its confidence threshold. Persisted via
 *    the `models` settings section like every other panel.
 * 2. **Library** — every model Clippity can manage, with live status
 *    from {@link useModels}: download (with progress + cancel),
 *    remove, retry-after-error. The backend owns the files; this
 *    panel only issues commands and renders the event stream.
 */
export function ModelsPanel({ value, onChange }: ModelsPanelProps) {
  const models = useModels();
  const checks = useReleaseChecks();
  const detectors = models?.filter((m) => m.task === "object-detection");
  // Outdated models still occupy disk (an older release's bytes), so
  // count them toward the storage line alongside current installs.
  const installedBytes = (models ?? [])
    .filter((m) => m.phase === "installed" || m.phase === "update-available")
    .reduce((sum, m) => sum + m.sizeBytes, 0);

  return (
    <>
      <SectionCard title="Behaviour">
        <Row
          label="Auto-download models"
          description="Fetch a feature's model automatically the first time you use it. Turn off to download only from this page."
          control={
            <ToggleSwitch
              checked={value.autoDownload}
              onChange={(autoDownload) => onChange({ ...value, autoDownload })}
              label="Auto-download models"
            />
          }
        />
        <Row
          label="Object capture model"
          description="The detector behind the Object capture mode. UI Elements is tuned for buttons, icons, and app chrome; the General models recognize everyday objects."
          control={
            <div className="inline-flex flex-col items-stretch gap-1">
              {(detectors ?? []).map((m) => {
                const active = value.objectModel === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChange({ ...value, objectModel: m.id })}
                    className={cn(
                      "focus-ring inline-flex items-center justify-between gap-3 rounded-[8px] border px-3 py-1.5 text-left text-[12px] font-medium transition-colors",
                      active
                        ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[var(--color-ink)]"
                        : "border-[color:var(--hairline)] text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                    )}
                  >
                    <span className="truncate">{m.label}</span>
                    {m.phase === "update-available" ||
                    hasLiveUpdate(checks?.[m.id]) ? (
                      <span className="shrink-0 text-[11px] text-[var(--color-accent)]">
                        update available
                      </span>
                    ) : m.phase === "installed" ? (
                      <Check
                        size={13}
                        strokeWidth={2.2}
                        className="shrink-0 text-[var(--color-accent)]"
                      />
                    ) : (
                      <span className="shrink-0 text-[11px] text-[var(--color-hint)]">
                        not installed
                      </span>
                    )}
                  </button>
                );
              })}
              {!detectors?.length && (
                <span className="text-[12px] text-[var(--color-hint)]">
                  Loading…
                </span>
              )}
            </div>
          }
        />
        <Row
          label="Detection sensitivity"
          description="Lower finds more objects (with more false positives); higher keeps only confident hits."
          control={
            <TickedSlider
              value={value.confidence}
              min={CONFIDENCE_MIN_PCT}
              max={CONFIDENCE_MAX_PCT}
              step={CONFIDENCE_STEP_PCT}
              tickStep={CONFIDENCE_TICK_STEP_PCT}
              onChange={(confidence) => onChange({ ...value, confidence })}
              ariaLabel="Detection confidence threshold"
              formatValue={(v) => `${v}%`}
            />
          }
        />
      </SectionCard>

      <SectionCard title="On-device models">
        {models === null && (
          <p className="px-5 py-4 text-[12.5px] text-[var(--color-hint)]">
            Loading models…
          </p>
        )}
        {models?.map((m) => (
          <ModelRow
            key={m.id}
            model={m}
            check={checks?.[m.id]}
            checking={checks === null}
          />
        ))}
        {models && (
          <p className="px-5 py-3 text-[12px] text-[var(--color-hint)]">
            Models run entirely on this device — nothing you capture leaves it.
            Installed: {formatMB(installedBytes)}.
          </p>
        )}
      </SectionCard>
    </>
  );
}

/** One model with its status-dependent action cluster. Command calls
 *  are optimistic-free: the row re-renders from `models/changed` +
 *  `models/progress`, so a failed invoke just leaves the row as-is.
 *
 *  `check` is the live GitHub-release verdict (absent when the check is
 *  still running, failed, or the model isn't GitHub-hosted); `checking`
 *  flags the first-load window so an installed row can say "checking…"
 *  instead of flashing a stale verdict. */
function ModelRow({
  model,
  check,
  checking,
}: {
  model: ModelInfo;
  check?: ReleaseCheck;
  checking: boolean;
}) {
  // Guards double-clicks between the invoke and its `changed` event.
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  // A live release is newer than what's on disk and fetchable — the real
  // self-update path. Takes precedence over the compile-time
  // `update-available` phase, which only knows releases baked into the app.
  const liveUpdate = hasLiveUpdate(check);
  // The latest published release is resolvable and fetchable — so a
  // not-installed model can be installed straight at the newest tag rather
  // than the older one the registry URL pins.
  const canFetchLatest = !!check && check.updatable;
  const showInstalledControls =
    model.phase === "installed" || model.phase === "update-available";

  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-[var(--color-ink)]">
            {model.label}
            <span className="ml-2 text-[11px] font-normal text-[var(--color-hint)]">
              {model.hint}
            </span>
          </p>
          <p className="mt-0.5 text-[12px] text-[var(--color-slate)]">
            {model.description}
          </p>
          <ReleaseLine
            model={model}
            check={check}
            checking={checking}
            liveUpdate={liveUpdate}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {model.phase === "not-installed" &&
            (canFetchLatest ? (
              // Install the newest published release directly.
              <ActionButton
                icon={<Download size={13} strokeWidth={2} />}
                label={`Download ${check!.latestTag} (${formatMB(model.sizeBytes)})`}
                accent
                disabled={busy}
                onClick={() => run(() => modelsUpdate(model.id))}
              />
            ) : (
              <ActionButton
                icon={<Download size={13} strokeWidth={2} />}
                label={`Download (${formatMB(model.sizeBytes)})`}
                accent
                disabled={busy}
                onClick={() => run(() => modelsDownload(model.id))}
              />
            ))}
          {model.phase === "downloading" && (
            <ActionButton
              icon={<X size={13} strokeWidth={2} />}
              label="Cancel"
              disabled={busy}
              onClick={() => run(() => modelsCancelDownload(model.id))}
            />
          )}
          {showInstalledControls &&
            (liveUpdate || model.phase === "update-available" ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-accent)]">
                <RefreshCw size={12} strokeWidth={2.4} />
                Update available
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-accent)]">
                <Check size={12} strokeWidth={2.4} />
                Installed
              </span>
            ))}
          {/* Live self-update to the newest published release (fetches the
              release's live assets). */}
          {liveUpdate && (
            <ActionButton
              icon={<Download size={13} strokeWidth={2} />}
              label={`Update to ${check!.latestTag}`}
              accent
              disabled={busy}
              onClick={() => run(() => modelsUpdate(model.id))}
            />
          )}
          {/* Compile-time update, only when there's no live check to drive
              the self-update path (offline, or non-GitHub model). */}
          {model.phase === "update-available" && !liveUpdate && !check && (
            <ActionButton
              icon={<Download size={13} strokeWidth={2} />}
              label={`Update to v${model.version}`}
              accent
              disabled={busy}
              onClick={() => run(() => modelsDownload(model.id))}
            />
          )}
          {showInstalledControls && (
            <ActionButton
              icon={<Trash2 size={13} strokeWidth={2} />}
              label="Remove"
              disabled={busy}
              onClick={() => run(() => modelsRemove(model.id))}
            />
          )}
          {model.phase === "error" && (
            <ActionButton
              icon={<Download size={13} strokeWidth={2} />}
              label="Retry"
              accent
              disabled={busy}
              onClick={() =>
                run(() =>
                  canFetchLatest
                    ? modelsUpdate(model.id)
                    : modelsDownload(model.id)
                )
              }
            />
          )}
        </div>
      </div>

      {model.phase === "downloading" && (
        <DownloadProgress
          downloaded={model.downloaded ?? 0}
          total={model.total || model.sizeBytes}
        />
      )}
      {model.phase === "error" && model.message && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-[var(--color-danger,#d4533b)]">
          <AlertTriangle
            size={13}
            strokeWidth={2}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0 break-words">{model.message}</span>
        </p>
      )}
    </div>
  );
}

/** The version/freshness line under a model's description: which version is
 *  installed, and how it compares to the latest published GitHub release.
 *  Renders nothing for a model with nothing installed and no release info. */
function ReleaseLine({
  model,
  check,
  checking,
  liveUpdate,
}: {
  model: ModelInfo;
  check?: ReleaseCheck;
  checking: boolean;
  liveUpdate: boolean;
}) {
  const installed = model.installedVersion;
  // Only models that are actually installed get a freshness verdict.
  const isInstalled =
    model.phase === "installed" || model.phase === "update-available";

  let status: ReactNode = null;
  if (isInstalled && liveUpdate && check) {
    status = (
      <span className="text-[var(--color-accent)]">
        newer release {check.latestTag} available
      </span>
    );
  } else if (isInstalled && check?.installedIsLatest) {
    status = (
      <span className="text-[var(--color-hint)]">latest published release</span>
    );
  } else if (!isInstalled && check) {
    // Not installed but we know the latest published release — name it so
    // the Download button's tag has context.
    status = (
      <span className="text-[var(--color-hint)]">
        latest release: {check.latestTag}
      </span>
    );
  } else if (model.checkable && checking) {
    // Only GitHub-checkable models get a "checking…" — others never
    // resolve a verdict and shouldn't claim to be checking one.
    status = (
      <span className="text-[var(--color-hint)]">checking for updates…</span>
    );
  }

  if (!installed && !status) return null;

  return (
    <p className="mt-1 flex items-center gap-1.5 text-[11px]">
      {installed && (
        <span className="text-[var(--color-slate)]">
          Installed: <span className="font-mono">{installed}</span>
        </span>
      )}
      {installed && status && (
        <span className="text-[var(--color-hint)]">·</span>
      )}
      {status}
    </p>
  );
}

function DownloadProgress({
  downloaded,
  total,
}: {
  downloaded: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
  return (
    <div className="mt-2.5 flex items-center gap-3">
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[color:var(--color-overlay-2)]"
      >
        <div
          className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
        {/* Quarter-way interval marks — same tick treatment as the
            sensitivity slider, for a sense of how far along the fetch is. */}
        <TrackTicks at={[0.25, 0.5, 0.75]} />
      </div>
      <span className="w-24 shrink-0 text-right font-mono text-[11px] text-[var(--color-slate)]">
        {formatMB(downloaded)} / {formatMB(total)}
      </span>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  accent = false,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick(): void;
  accent?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "focus-ring inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        accent
          ? "bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:opacity-90"
          : "border border-[color:var(--hairline)] text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Megabyte formatter for model artifacts (they're all MB-scale). */
function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
