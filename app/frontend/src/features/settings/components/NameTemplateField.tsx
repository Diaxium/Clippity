import { cn } from "@shared/lib/cn";

import {
  DEFAULT_NAME_TEMPLATE,
  NAME_TEMPLATE_TOKENS,
} from "@services/tauri/clients/settings";

import { previewName } from "../lib/nameTemplatePreview";

interface NameTemplateFieldProps {
  value: string;
  onChange(next: string): void;
}

/**
 * Capture file-name pattern editor: a monospace template input, a live
 * example of the resulting filename, and the available token legend.
 * Empty value means "use the backend default" — the placeholder shows it.
 */
export function NameTemplateField({ value, onChange }: NameTemplateFieldProps) {
  return (
    <div className="flex w-[340px] flex-col gap-2">
      <input
        type="text"
        value={value}
        placeholder={DEFAULT_NAME_TEMPLATE}
        spellCheck={false}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={cn(
          "focus-ring h-9 w-full rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-3 text-[12.5px] font-mono",
          "text-[var(--color-ink)] placeholder:text-[var(--color-hint)]"
        )}
        aria-label="Capture file name pattern"
      />
      <p className="text-[11.5px] text-[var(--color-slate)]">
        Example:{" "}
        <span className="font-mono text-[var(--color-ink)]">
          {previewName(value)}
        </span>
      </p>
      <ul className="flex flex-col gap-0.5 text-[11px] text-[var(--color-hint)]">
        {NAME_TEMPLATE_TOKENS.map((t) => (
          <li key={t.token}>
            <code className="font-mono text-[var(--color-slate)]">
              {t.token}
            </code>{" "}
            — {t.description}
          </li>
        ))}
      </ul>
    </div>
  );
}
