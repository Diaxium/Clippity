import { Moon, Settings, Sun } from "lucide-react";
import type { ComponentType } from "react";

import { useThemeStore } from "@state/themeStore";
import type { Theme } from "@state/themeStore";
import { cn } from "@shared/lib/cn";

interface ThemeToggleProps {
  /** Compact rail layout — buttons stack vertically. */
  collapsed?: boolean;
  /** Optional Settings shortcut. Renders to the right (or below in
   *  collapsed mode) of the theme buttons. */
  onSettings?: () => void;
  /** Highlight the Settings button when it's the current view. */
  settingsActive?: boolean;
  /** Optional persistence hook — when provided, the explicit
   *  light/dark click routes through here (typically a
   *  `useSettingsPatch` wrapper). The component still mirrors into
   *  `themeStore` for snappy local feedback. */
  onThemeChange?: (next: Theme) => void;
  /** Optional leading "switch workspace" action — the capture window
   *  passes a Dashboard target, the dashboard window passes a Capture
   *  target, so one pill cross-navigates between the two primary
   *  windows. Rendered as the first button when `onSwitch` is set. */
  onSwitch?: () => void;
  /** Icon for the switch button (e.g. `LayoutDashboard` / `Focus`). */
  switchIcon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Accessible label + tooltip for the switch button. */
  switchLabel?: string;
}

const THEMES: { id: Theme; icon: typeof Sun; label: string }[] = [
  { id: "light", icon: Sun, label: "Light theme" },
  { id: "dark", icon: Moon, label: "Dark theme" },
];

const BTN_BASE =
  "focus-ring grid h-8 w-8 place-items-center rounded-md transition-colors";

/**
 * Bottom-of-sidebar utility cluster: an optional leading "switch
 * workspace" button (Dashboard ⇄ Capture), explicit Light / Dark
 * buttons, and an optional Settings shortcut, all sharing one rounded
 * pill. Reads + writes the global theme store directly.
 *
 * Active theme renders against the surface fill with a subtle inset
 * shadow so the current choice is unambiguous — matches the legacy
 * footer cluster's feel. Hubs that surface Settings as a dedicated
 * sidebar row (e.g. the future Main hub) omit `onSettings`.
 */
export function ThemeToggle({
  collapsed = false,
  onSettings,
  settingsActive = false,
  onThemeChange,
  onSwitch,
  switchIcon: SwitchIcon,
  switchLabel,
}: ThemeToggleProps) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const handleThemePick = (next: Theme) => {
    // Mirror locally for instant feedback; persistence (when wired)
    // arrives via `onThemeChange` and pushes the same value back
    // through the settings change event.
    setTheme(next);
    onThemeChange?.(next);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-xl bg-[color:var(--color-overlay-1)] p-1",
        collapsed && "flex-col"
      )}
    >
      {onSwitch && SwitchIcon && (
        <button
          type="button"
          aria-label={switchLabel ?? "Switch window"}
          title={switchLabel}
          onClick={onSwitch}
          className={cn(
            BTN_BASE,
            "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          )}
        >
          <SwitchIcon size={15} strokeWidth={1.85} />
        </button>
      )}

      {THEMES.map(({ id, icon: Icon, label }) => {
        const active = theme === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => handleThemePick(id)}
            className={cn(
              BTN_BASE,
              active
                ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
                : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
            )}
          >
            <Icon size={15} strokeWidth={1.85} />
          </button>
        );
      })}

      {onSettings && (
        <button
          type="button"
          aria-label="Open Settings"
          aria-pressed={settingsActive}
          onClick={onSettings}
          className={cn(
            BTN_BASE,
            settingsActive
              ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
              : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          )}
        >
          <Settings size={15} strokeWidth={1.85} />
        </button>
      )}
    </div>
  );
}
