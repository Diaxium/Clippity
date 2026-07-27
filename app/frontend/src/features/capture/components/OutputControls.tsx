import { Send, Sparkles } from "lucide-react";

import { Select } from "@shared/ui";
import type { SelectOption } from "@shared/ui";

import { useCaptureStore } from "../state/captureStore";
import { CollapsibleSection } from "./CollapsibleSection";
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

interface OutputControlsProps {
  startIndex?: number;
}

/**
 * Effects + Share Destination dropdowns. UI-final but their values
 * are NOT yet passed to the backend pipeline — see the tech-debt
 * entry in REBUILD.md. Wired into the store so the user's choice
 * survives the round-trip when implementation lands.
 */
export function OutputControls({ startIndex = 3 }: OutputControlsProps) {
  const effect = useCaptureStore((s) => s.effect);
  const share = useCaptureStore((s) => s.share);
  const setEffect = useCaptureStore((s) => s.setEffect);
  const setShare = useCaptureStore((s) => s.setShare);

  return (
    <CollapsibleSection n={startIndex} title="Output">
      <div className="grid grid-cols-1 gap-5 rounded-[14px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-3.5 shadow-[var(--shadow-medium)] sm:grid-cols-2">
        <div className="flex items-start gap-3.5">
          <IconTile icon={Sparkles} tint="warm" />
          <div className="min-w-0 flex-1">
            <label className="mb-2 block text-[12px] font-medium text-[var(--color-slate)]">
              Effects
            </label>
            <Select
              value={effect}
              options={EFFECT_OPTIONS}
              onChange={setEffect}
              ariaLabel="Effects"
              triggerClassName="h-[44px] rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-3.5 transition-colors hover:bg-[var(--color-surface)]"
            />
          </div>
        </div>
        <div className="flex items-start gap-3.5">
          <IconTile icon={Send} tint="cool" />
          <div className="min-w-0 flex-1">
            <label className="mb-2 block text-[12px] font-medium text-[var(--color-slate)]">
              Share Destination
            </label>
            <Select
              value={share}
              options={SHARE_OPTIONS}
              onChange={setShare}
              ariaLabel="Share destination"
              triggerClassName="h-[44px] rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-3.5 transition-colors hover:bg-[var(--color-surface)]"
            />
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
