import { Send, Sparkles } from "lucide-react";

import { Select, ToggleSwitch } from "@shared/ui";
import type { SelectOption } from "@shared/ui";

import { useCaptureStore } from "../state/captureStore";
import { CaptureTypeGrid } from "./CaptureTypeGrid";
import { IconTile } from "./IconTile";

const EFFECT_OPTIONS: readonly SelectOption[] = [
  { value: "none", label: "None" },
  { value: "blur", label: "Blur" },
  { value: "highlight", label: "Highlight" },
  { value: "pixelate", label: "Pixelate" },
  { value: "shadow", label: "Shadow" },
  { value: "border", label: "Border" },
];

const SHARE_OPTIONS: readonly SelectOption[] = [
  { value: "none", label: "None" },
  { value: "file", label: "File" },
  { value: "clipboard", label: "Clipboard" },
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack" },
  { value: "drive", label: "Google Drive" },
  { value: "dropbox", label: "Dropbox" },
];

const INLINE_OPTIONS = [
  {
    key: "preview" as const,
    label: "Preview",
    icon: Sparkles,
    tint: "warm" as const,
  },
] satisfies ReadonlyArray<{
  key: "preview" | "clipboard" | "cursor";
  label: string;
  icon: typeof Sparkles;
  tint: "warm" | "cool";
}>;

/**
 * Single-row low-profile layout. Authored to match the legacy compact
 * mode but **unreachable in MVP** — the user has no path to flip the
 * compact bit until the settings port lands.
 */
export function CompactCaptureRow() {
  const preview = useCaptureStore((s) => s.preview);
  const setOption = useCaptureStore((s) => s.setOption);
  const effect = useCaptureStore((s) => s.effect);
  const share = useCaptureStore((s) => s.share);
  const setEffect = useCaptureStore((s) => s.setEffect);
  const setShare = useCaptureStore((s) => s.setShare);

  return (
    <div className="flex flex-1 items-center gap-3 overflow-x-auto px-4 py-2">
      <CaptureTypeGrid compact />

      <span
        aria-hidden
        className="h-7 w-px shrink-0 bg-[color:var(--hairline)]"
      />

      <div className="flex items-center gap-2">
        {INLINE_OPTIONS.map((o) => (
          <span
            key={o.key}
            title={o.label}
            className="inline-flex items-center gap-1.5 rounded-full border border-[color:var(--hairline)] bg-[var(--color-surface)] px-1 py-1 shadow-[var(--shadow-subtle)]"
          >
            <IconTile icon={o.icon} tint={o.tint} />
            <ToggleSwitch
              checked={preview}
              onChange={(v) => setOption(o.key, v)}
              label={o.label}
            />
          </span>
        ))}
      </div>

      <span
        aria-hidden
        className="h-7 w-px shrink-0 bg-[color:var(--hairline)]"
      />

      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5">
          <Sparkles
            size={14}
            strokeWidth={1.85}
            className="text-[var(--color-slate)]"
          />
          <Select
            value={effect}
            options={EFFECT_OPTIONS}
            onChange={setEffect}
            ariaLabel="Effects"
            triggerClassName="h-9 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2.5 transition-colors hover:bg-[var(--color-surface-2)]"
          />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Send
            size={14}
            strokeWidth={1.85}
            className="text-[var(--color-slate)]"
          />
          <Select
            value={share}
            options={SHARE_OPTIONS}
            onChange={setShare}
            ariaLabel="Share destination"
            triggerClassName="h-9 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2.5 transition-colors hover:bg-[var(--color-surface-2)]"
          />
        </span>
      </div>
    </div>
  );
}
