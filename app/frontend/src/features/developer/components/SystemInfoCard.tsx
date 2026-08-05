/**
 * System information + the monitor layout.
 *
 * One fetch on mount, refreshed on demand: versions and paths don't
 * change under the page, and a monitor layout that changed while you
 * were looking at it is exactly what the Refresh button is for.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  getRuntimeStatus,
  getSystemInfo,
  type RuntimeStatus,
  type SystemInfo,
} from "@services/tauri/clients/developer";
import { Button } from "@shared/ui";
import { SectionCard } from "@features/settings/components/SectionCard";

import {
  formatBytes,
  formatDuration,
  formatMonitor,
  formatSystemSummary,
} from "../lib/format";
import { ActionRow, CopyButton, StatLine } from "./DevRow";

/**
 * Fetch the system information and runtime status together.
 *
 * Exported because three surfaces want the same pair — this card, the
 * capture-diagnostics card (monitors) and the bundle card (path to show
 * after an export) — and three independent fetches of the same two
 * commands on one page render is a cost with no reader.
 */
export function useDiagnostics() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    void Promise.all([getSystemInfo(), getRuntimeStatus()])
      .then(([nextInfo, nextStatus]) => {
        setInfo(nextInfo);
        setStatus(nextStatus);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return { info, status, error, loading, refresh };
}

interface SystemInfoCardProps {
  info: SystemInfo | null;
  status: RuntimeStatus | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}

export function SystemInfoCard({
  info,
  status,
  error,
  loading,
  onRefresh,
}: SystemInfoCardProps) {
  return (
    <SectionCard title="System information">
      <ActionRow
        label="This installation"
        description="Versions, folders and displays, as this process resolved them. The copy is unredacted — it includes your real paths."
      >
        <CopyButton
          text={() => (info ? formatSystemSummary(info, status) : "")}
          label="Copy summary"
          disabled={!info}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw size={13} strokeWidth={2} />
          Refresh
        </Button>
      </ActionRow>

      {error && (
        <p className="px-5 py-3 text-[12.5px] text-[var(--color-accent)]">
          Diagnostics could not be read: {error}
        </p>
      )}

      {info && (
        <div className="py-2">
          <StatLine
            label="Version"
            value={`${info.appVersion} · ${info.buildProfile}${
              info.portable ? " · portable" : ""
            }`}
          />
          <StatLine label="Operating system" value={info.osVersion} />
          <StatLine
            label="Architecture"
            value={`${info.arch} · ${info.cpuCount} cores`}
          />
          <StatLine label="WebView" value={info.webviewVersion ?? "unknown"} />
          <StatLine label="Uptime" value={formatDuration(info.uptimeMs)} />
          <StatLine
            label="Log on disk"
            value={
              info.logFile
                ? `${formatBytes(info.logBytes)}`
                : "not writing to disk"
            }
          />
          <StatLine
            label="Models installed"
            value={
              info.installedModels.length > 0
                ? info.installedModels.join(", ")
                : "none"
            }
          />
        </div>
      )}

      {info && (
        <div className="py-2">
          <p className="px-5 pt-1 pb-1 text-[12px] font-medium text-[var(--color-ink)]">
            Folders
          </p>
          <StatLine label="Data" value={info.paths.data} />
          <StatLine label="Captures" value={info.paths.captures} />
          <StatLine label="Cache" value={info.paths.cache} />
          <StatLine label="Models" value={info.paths.models} />
          <StatLine label="Logs" value={info.paths.logs} />
          <StatLine label="Executable" value={info.paths.executable} />
        </div>
      )}

      {info && (
        <div className="py-2">
          <p className="px-5 pt-1 pb-1 text-[12px] font-medium text-[var(--color-ink)]">
            Displays
          </p>
          {info.monitors.length === 0 && (
            <p className="px-5 py-1.5 text-[12px] text-[var(--color-slate)]">
              No monitors reported — which is itself the diagnosis if captures
              are failing.
            </p>
          )}
          {info.monitors.map((monitor) => (
            <StatLine
              key={`${monitor.id}-${monitor.x}-${monitor.y}`}
              label={monitor.name}
              value={formatMonitor(monitor)}
              tone={monitor.hdr ? "warn" : "normal"}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
