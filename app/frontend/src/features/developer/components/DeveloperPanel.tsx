/**
 * Settings → Advanced. Developer mode, the tools it reveals, logging,
 * diagnostics, and the instrumentation surfaces.
 *
 * Two layers, and the split is the whole design of the page:
 *
 * - **Always available**: logging (level, disk, retention, the viewer),
 *   the system-information card, and the diagnostics bundle. A user who
 *   never turns developer mode on can still answer "what is my setup?"
 *   and "here is the session that went wrong", which is the entire
 *   point of shipping any of this.
 * - **Behind developer mode**: the developer tools, the live
 *   instrumentation, the feature flags, the cache-clearing, and safe
 *   mode. These reveal destructive actions and can record IPC metadata,
 *   so they ship off and — by default — disarm on the next restart.
 */

import { useCallback, useState } from "react";
import { Bug, ExternalLink, LifeBuoy, ShieldAlert } from "lucide-react";

import {
  restartInSafeMode,
  setDevtoolsOpen,
  clearLogs,
  type RuntimeFlags,
} from "@services/tauri/clients/developer";
import { Button, Select, Stepper, ToggleSwitch } from "@shared/ui";
import type { FlagOverrides } from "@shared/lib/featureFlags";
import { Row } from "@features/settings/components/Row";
import { SectionCard } from "@features/settings/components/SectionCard";
import {
  DEVELOPER_EXPIRY_OPTIONS,
  LOG_FILES_MAX,
  LOG_FILES_MIN,
  LOG_FILE_MB_MAX,
  LOG_FILE_MB_MIN,
  LOG_LEVEL_OPTIONS,
  SLOW_COMMAND_OPTIONS,
} from "@features/settings/constants";
import type {
  DeveloperExpiry,
  DeveloperSettings,
  LogLevel,
} from "@features/settings/types";

import { formatBytes } from "../lib/format";
import { BundleCard } from "./BundleCard";
import { ActionRow, DangerButton, ResultNote } from "./DevRow";
import { FeatureFlagsCard } from "./FeatureFlagsCard";
import { IpcInspector } from "./IpcInspector";
import { LogViewer } from "./LogViewer";
import { RecordingCard } from "./RecordingCard";
import { RuntimeCard } from "./RuntimeCard";
import { SystemInfoCard, useDiagnostics } from "./SystemInfoCard";

interface DeveloperPanelProps {
  value: DeveloperSettings;
  onChange(next: DeveloperSettings): void;
  /** Facts that override what the settings say, so the page can
   *  describe what is actually in force. Null while it loads. */
  flags: RuntimeFlags | null;
}

export function DeveloperPanel({
  value,
  onChange,
  flags,
}: DeveloperPanelProps) {
  const { info, status, error, loading, refresh } = useDiagnostics();
  const [note, setNote] = useState<string | null>(null);
  const set = useCallback(
    (patch: Partial<DeveloperSettings>) => onChange({ ...value, ...patch }),
    [onChange, value]
  );

  const devMode = value.enabled;

  return (
    <>
      {flags?.safeMode && (
        <div className="mb-6 flex items-start gap-3 rounded-[14px] border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] px-5 py-4">
          <ShieldAlert
            size={16}
            strokeWidth={1.9}
            className="mt-0.5 shrink-0 text-[var(--color-accent)]"
          />
          <div>
            <p className="text-[13px] font-semibold text-[var(--color-ink)]">
              Running in safe mode
            </p>
            <p className="mt-0.5 text-[12.5px] text-[var(--color-slate)]">
              Hardware acceleration, window effects and the global capture
              hotkey are off for this session, whatever your settings say.
              Restart normally to leave safe mode.
            </p>
          </div>
        </div>
      )}

      <SectionCard title="Developer mode">
        <Row
          label="Developer mode"
          description="Reveals the tools, live instrumentation and destructive actions below. Off by default — some of these record command metadata."
          control={
            <ToggleSwitch
              checked={value.enabled}
              onChange={(enabled) => set({ enabled })}
              label="Developer mode"
            />
          }
        />
        <Row
          label="Turn off automatically"
          description="Developer mode reveals destructive actions, so it disarms on its own unless you say otherwise."
          control={
            <Select
              value={value.expiry}
              options={DEVELOPER_EXPIRY_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              onChange={(expiry) => set({ expiry: expiry as DeveloperExpiry })}
              ariaLabel="Developer mode expiry"
              triggerClassName="h-8 min-w-[11rem] text-[12.5px]"
            />
          }
        />
        <Row
          label="Confirm destructive actions"
          description="Ask before clearing a cache or rebuilding the index, and say exactly what will be removed."
          control={
            <ToggleSwitch
              checked={value.confirmDestructive}
              onChange={(confirmDestructive) => set({ confirmDestructive })}
              label="Confirm destructive actions"
            />
          }
        />
        <Row
          label="Show developer actions throughout Clippity"
          description="Adds Copy debug info and Open logs to context menus outside this page."
          control={
            <ToggleSwitch
              checked={value.showActions}
              onChange={(showActions) => set({ showActions })}
              label="Show developer actions throughout Clippity"
              disabled={!devMode}
            />
          }
        />
      </SectionCard>

      {devMode && (
        <SectionCard title="Developer tools">
          <ActionRow
            label="Developer tools"
            description={
              flags && !flags.devtoolsAvailable
                ? "This build was compiled without the WebView inspector."
                : "Open the WebView inspector for this window."
            }
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={flags ? !flags.devtoolsAvailable : false}
              onClick={() =>
                void setDevtoolsOpen(true).catch((err: unknown) =>
                  setNote(
                    `Developer tools could not open: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  )
                )
              }
            >
              <Bug size={13} strokeWidth={2} />
              Open
            </Button>
          </ActionRow>
          <Row
            label="Open developer tools at startup"
            description="Opens the inspector for the dashboard window on every launch."
            control={
              <ToggleSwitch
                checked={value.devtoolsOnStartup}
                onChange={(devtoolsOnStartup) => set({ devtoolsOnStartup })}
                label="Open developer tools at startup"
              />
            }
          />
          <ActionRow
            label="Reload the interface"
            description="Reloads this window's webview. Backend state, including any running recording, is untouched."
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </ActionRow>
          <ActionRow
            label="Restart in safe mode"
            description="Restarts with hardware acceleration, window effects and the global hotkey off — the state to boot into when one of them is why Clippity misbehaves. Lasts one launch."
          >
            <DangerButton
              label="Restart"
              confirmLabel="Restart into safe mode"
              confirm={value.confirmDestructive}
              onConfirm={() => void restartInSafeMode()}
            />
          </ActionRow>
          <ResultNote>{note}</ResultNote>
        </SectionCard>
      )}

      <SectionCard title="Logging">
        <Row
          label="Backend log level"
          description={
            flags?.logLevelPinned
              ? "CLIPPITY_LOG is set in this environment, so it is driving the filter and this setting is inert for this process."
              : "How much the Rust side records. Applies immediately."
          }
          control={
            <Select
              value={value.backendLog}
              options={LOG_LEVEL_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              onChange={(backendLog) =>
                set({ backendLog: backendLog as LogLevel })
              }
              ariaLabel="Backend log level"
              triggerClassName="h-8 min-w-[8rem] text-[12.5px]"
              disabled={flags?.logLevelPinned === true}
            />
          }
        />
        <Row
          label="Frontend log level"
          description="How much the interface records — and mirrors into the same log file, so both halves share one timeline."
          control={
            <Select
              value={value.frontendLog}
              options={LOG_LEVEL_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              onChange={(frontendLog) =>
                set({ frontendLog: frontendLog as LogLevel })
              }
              ariaLabel="Frontend log level"
              triggerClassName="h-8 min-w-[8rem] text-[12.5px]"
            />
          }
        />
        <Row
          label="Write logs to disk"
          description={
            info?.logFile
              ? `Rotating files under the logs folder — currently ${formatBytes(
                  info.logBytes
                )}.`
              : "Rotating files under the logs folder. Off means a bug report has no session attached."
          }
          control={
            <ToggleSwitch
              checked={value.logToDisk}
              onChange={(logToDisk) => set({ logToDisk })}
              label="Write logs to disk"
            />
          }
        />
        <Row
          label="Rotate at (MB)"
          description="Size at which the live log file is rotated and a new one started."
          control={
            <Stepper
              value={value.logMaxFileMb}
              min={LOG_FILE_MB_MIN}
              max={LOG_FILE_MB_MAX}
              onChange={(logMaxFileMb) => set({ logMaxFileMb })}
              label="log file size limit in MB"
            />
          }
        />
        <Row
          label="Files kept"
          description="Rotated files retained beside the live one. Older ones are deleted as new ones rotate in."
          control={
            <Stepper
              value={value.logRetainFiles}
              min={LOG_FILES_MIN}
              max={LOG_FILES_MAX}
              onChange={(logRetainFiles) => set({ logRetainFiles })}
              label="number of rotated log files to keep"
            />
          }
        />
        <ActionRow
          label="Log files"
          description="Everything recorded stays on this machine until you export or share it."
        >
          <DangerButton
            label="Clear logs"
            confirmLabel="Delete every log file"
            confirm={value.confirmDestructive}
            onConfirm={() => {
              void clearLogs().then(
                (freed) => {
                  setNote(`Cleared the logs — freed ${formatBytes(freed)}.`);
                  refresh();
                },
                (err: unknown) =>
                  setNote(
                    `Clearing the logs failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`
                  )
              );
            }}
          />
        </ActionRow>
        <LogViewer />
      </SectionCard>

      <SystemInfoCard
        info={info}
        status={status}
        error={error}
        loading={loading}
        onRefresh={refresh}
      />

      <BundleCard
        redactByDefault={value.redactDiagnostics}
        onRedactChange={(redactDiagnostics) => set({ redactDiagnostics })}
      />

      {devMode && (
        <>
          <SectionCard title="Instrumentation">
            <Row
              label="Performance overlay"
              description="A live readout of frame rate, main-thread delay, memory and IPC throughput in the corner of every Clippity window."
              control={
                <ToggleSwitch
                  checked={value.performanceOverlay}
                  onChange={(performanceOverlay) => set({ performanceOverlay })}
                  label="Performance overlay"
                />
              }
            />
            <Row
              label="Record command timing"
              description="Times every IPC call and keeps a rolling window of durations, payload sizes and failures for the inspector below."
              control={
                <ToggleSwitch
                  checked={value.commandTiming}
                  onChange={(commandTiming) => set({ commandTiming })}
                  label="Record command timing"
                />
              }
            />
            <Row
              label="Flag operations slower than"
              description="Calls at or over this duration are highlighted in the inspector."
              control={
                <Select
                  value={String(value.slowCommandMs)}
                  options={SLOW_COMMAND_OPTIONS.map((o) => ({
                    value: String(o.value),
                    label: o.label,
                  }))}
                  onChange={(ms) => set({ slowCommandMs: Number(ms) })}
                  ariaLabel="Slow command threshold"
                  triggerClassName="h-8 min-w-[11rem] text-[12.5px]"
                />
              }
            />
            <Row
              label="Capture diagnostics"
              description="Show display geometry, DPI scaling and HDR state alongside the system information."
              control={
                <ToggleSwitch
                  checked={value.captureDiagnostics}
                  onChange={(captureDiagnostics) => set({ captureDiagnostics })}
                  label="Capture diagnostics"
                />
              }
            />
            <Row
              label="Recording diagnostics"
              description="Show frame, drop and encoder statistics for the running and most recent recording."
              control={
                <ToggleSwitch
                  checked={value.recordingDiagnostics}
                  onChange={(recordingDiagnostics) =>
                    set({ recordingDiagnostics })
                  }
                  label="Recording diagnostics"
                />
              }
            />
          </SectionCard>

          <SectionCard title="Command inspector">
            <IpcInspector
              enabled={value.commandTiming}
              slowMs={value.slowCommandMs}
            />
          </SectionCard>

          {value.recordingDiagnostics && <RecordingCard />}

          <RuntimeCard
            status={status}
            confirmDestructive={value.confirmDestructive}
            onRefresh={refresh}
          />

          <FeatureFlagsCard
            overrides={value.featureFlags}
            onChange={(featureFlags: FlagOverrides) => set({ featureFlags })}
          />

          <p className="mb-6 flex items-start gap-2 px-1 text-[12px] text-[var(--color-slate)]">
            <LifeBuoy
              size={14}
              strokeWidth={1.9}
              className="mt-0.5 shrink-0 text-[var(--color-hint)]"
            />
            <span>
              Everything on this page stays on this machine. Nothing is sent
              anywhere unless you export a bundle and share it yourself.
            </span>
          </p>
        </>
      )}

      {!devMode && (
        <p className="mb-6 flex items-start gap-2 px-1 text-[12px] text-[var(--color-slate)]">
          <ExternalLink
            size={14}
            strokeWidth={1.9}
            className="mt-0.5 shrink-0 text-[var(--color-hint)]"
          />
          <span>
            Turn on developer mode for the WebView inspector, live
            instrumentation, feature flags, cache tools and safe mode.
          </span>
        </p>
      )}
    </>
  );
}
