import { cn } from "@shared/lib/cn";

import { CORNER_OPTIONS, DURATION_ROWS } from "../constants";
import type { NotificationSettings, ToastDurations } from "../types";
import { DurationSlider } from "./DurationSlider";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

interface NotificationsPanelProps {
  value: NotificationSettings;
  onChange(next: NotificationSettings): void;
}

export function NotificationsPanel({
  value,
  onChange,
}: NotificationsPanelProps) {
  const setDuration = (key: keyof ToastDurations, ms: number) => {
    onChange({
      ...value,
      durations: { ...value.durations, [key]: ms },
    });
  };

  return (
    <>
      <SectionCard title="Placement">
        <Row
          label="Anchor corner"
          description="Toasts pin to this corner of the monitor under the cursor."
          control={
            <div className="inline-grid grid-cols-2 gap-1 rounded-[10px] bg-[color:var(--color-overlay-1)] p-1">
              {CORNER_OPTIONS.map((opt) => {
                const active = value.corner === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChange({ ...value, corner: opt.value })}
                    className={cn(
                      "focus-ring rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
                        : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          }
        />
      </SectionCard>

      <SectionCard title="Auto-dismiss timing">
        <div className="px-5 py-3 text-[12px] text-[var(--color-slate)]">
          How long each toast stays on screen. <strong>0 seconds</strong> keeps
          it sticky until you dismiss it. Hovering pauses the timer. Settings
          for upcoming features are saved now and take effect when those
          features arrive.
        </div>
        {DURATION_ROWS.map((row) => (
          <Row
            key={row.key}
            label={row.armed ? row.label : `${row.label} — coming soon`}
            description={row.description}
            control={
              <DurationSlider
                value={value.durations[row.key]}
                onChange={(ms) => setDuration(row.key, ms)}
                armed={row.armed}
              />
            }
          />
        ))}
      </SectionCard>
    </>
  );
}
