/**
 * Home view root — the dashboard's landing overview.
 *
 * A scrollable "welcome back" surface whose cards are fed from live
 * backend data: recent captures, resume-editing, and activity come from
 * one `library_list`; pinned presets from `presets_list`; the storage
 * meter from `library_storage`; the version from the Tauri runtime.
 * Loading and empty states are handled per card, so a fresh install (or
 * a browser-only preview where IPC is unavailable) renders cleanly
 * rather than blank.
 *
 * Capture entry points all route through one dispatch: the header
 * Capture button and the Screenshot/Window launcher cards fire the same
 * overlay flow, and the shortcut chips are live via
 * `useQuickCaptureHotkeys` (scoped to this view — see that hook).
 */

import { ChevronDown, Focus, Plus } from "lucide-react";

import { useSettings } from "@features/settings";
import { showCaptureWindow } from "@services/tauri/clients/toast";
import { cn } from "@shared/lib/cn";

import { useAppVersion } from "../hooks/useAppVersion";
import { useHomeCaptures } from "../hooks/useHomeCaptures";
import { useHomePresets } from "../hooks/useHomePresets";
import { useHomeStorage } from "../hooks/useHomeStorage";
import { useQuickCapture } from "../hooks/useQuickCapture";
import { useQuickCaptureHotkeys } from "../hooks/useQuickCaptureHotkeys";
import { ContinueEditing } from "./ContinueEditing";
import { PinnedPresets } from "./PinnedPresets";
import { QuickCapture } from "./QuickCapture";
import { RecentActivity } from "./RecentActivity";
import { RecentCaptures } from "./RecentCaptures";
import { StorageCard } from "./StorageSync";
import { WhatsNew } from "./WhatsNew";

/** The dashboard views the Home links can route to. */
export type HomeNavTarget = "library" | "editor" | "presets" | "settings";

interface HomeLayoutProps {
  /** Switch the dashboard to another view; `captureId` targets the editor. */
  onNavigate: (view: HomeNavTarget, captureId?: string) => void;
}

/** Basename of a save path, for the Storage card's Location row. */
function folderName(dir: string): string | null {
  const trimmed = dir.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

export function HomeLayout({ onNavigate }: HomeLayoutProps) {
  const captures = useHomeCaptures();
  const { presets, loading: presetsLoading } = useHomePresets();
  const { info, percent } = useHomeStorage();
  const version = useAppVersion();
  const settings = useSettings();

  const dispatch = useQuickCapture();
  useQuickCaptureHotkeys(dispatch);

  const openEditor = (id: string) => onNavigate("editor", id);
  const location = settings ? folderName(settings.general.capturesDir) : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1320px] flex-col gap-6 p-6 lg:p-8">
        <Header
          onNewProject={() => void showCaptureWindow()}
          onCapture={() => dispatch("screenshot")}
          onPickMode={() => void showCaptureWindow()}
        />

        <QuickCapture onLaunch={dispatch} />

        {/* Recent work — captures strip beside the resume-editing list. */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.25fr_1fr]">
          <RecentCaptures
            items={captures.recent}
            loading={captures.loading}
            onViewAll={() => onNavigate("library")}
            onOpen={openEditor}
          />
          <ContinueEditing
            items={captures.editing}
            loading={captures.loading}
            onViewAll={() => onNavigate("library")}
            onOpen={openEditor}
          />
        </div>

        {/* Status row. */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <PinnedPresets
            presets={presets}
            loading={presetsLoading}
            onManage={() => onNavigate("presets")}
            onAdd={() => onNavigate("presets")}
          />
          <StorageCard
            info={info}
            percent={percent}
            count={captures.count}
            location={location}
          />
          <RecentActivity
            items={captures.activity}
            loading={captures.loading}
            onViewAll={() => onNavigate("library")}
          />
          <WhatsNew
            version={version}
            onOpenSettings={() => onNavigate("settings")}
          />
        </div>
      </div>
    </div>
  );
}

function Header({
  onNewProject,
  onCapture,
  onPickMode,
}: {
  onNewProject: () => void;
  onCapture: () => void;
  onPickMode: () => void;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight text-[var(--color-ink)]">
          Home
        </h1>
        <p className="mt-0.5 text-[14px] text-[var(--color-slate)]">
          Welcome back <span className="align-middle">👋</span>
        </p>
      </div>

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onNewProject}
          className="focus-ring flex h-10 items-center gap-2 rounded-[12px] border border-[color:var(--hairline-strong)] bg-[var(--color-surface)] px-4 text-[13.5px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-overlay-1)]"
        >
          <Plus size={16} strokeWidth={2} />
          New project
        </button>

        <CaptureSplitButton onCapture={onCapture} onPickMode={onPickMode} />
      </div>
    </header>
  );
}

/**
 * Primary accent "Capture" action. The main half starts a region
 * screenshot straight away; the caret opens the full capture window to
 * pick a different mode.
 */
function CaptureSplitButton({
  onCapture,
  onPickMode,
}: {
  onCapture: () => void;
  onPickMode: () => void;
}) {
  const base =
    "focus-ring flex items-center bg-[var(--color-accent)] text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]";
  return (
    <div className="flex h-10 items-stretch overflow-hidden rounded-[12px] shadow-[var(--glow-coral)]">
      <button
        type="button"
        onClick={onCapture}
        className={cn(base, "gap-2 px-4 text-[13.5px] font-semibold")}
      >
        <Focus size={16} strokeWidth={2} />
        Capture
      </button>
      <span className="w-px bg-[color-mix(in_srgb,var(--color-accent-ink)_28%,transparent)]" />
      <button
        type="button"
        aria-label="Choose capture mode"
        onClick={onPickMode}
        className={cn(base, "px-2")}
      >
        <ChevronDown size={16} strokeWidth={2.2} />
      </button>
    </div>
  );
}
