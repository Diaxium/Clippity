import { Moon, Settings, Sun } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";

import { useThemeStore } from "@state/themeStore";
import type { Theme } from "@state/themeStore";
import { cn } from "@shared/lib/cn";

interface ThemeToggleProps {
  /** Compact rail layout — buttons stack vertically. */
  collapsed?: boolean;
  /** Optional Settings shortcut. Renders to the right (or below in
   *  collapsed mode) of the theme button. */
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

const BTN_BASE =
  "focus-ring relative isolate grid h-8 w-8 place-items-center overflow-hidden rounded-md transition-colors";

type UtilityAction = "switch" | "theme" | "settings";

interface UtilityButtonProps {
  action: UtilityAction;
  "aria-label": string;
  "aria-pressed"?: boolean;
  title?: string;
  onClick: () => void;
  className: string;
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  children?: ReactNode;
}

const UTILITY_MOTION = {
  switch: {
    button: {
      rest: { y: 0, scale: 1 },
      hover: { y: -2, scale: 1.04 },
    },
    icon: {
      rest: {
        x: 0,
        rotate: 0,
        scale: 1,
        transition: { type: "spring", stiffness: 430, damping: 27, mass: 0.5 },
      },
      hover: {
        x: 2,
        rotate: -10,
        scale: 1.12,
        transition: { type: "spring", stiffness: 520, damping: 21, mass: 0.45 },
      },
    },
  },
  theme: {
    button: {
      rest: { y: 0, scale: 1 },
      hover: { y: -1, scale: 1.04 },
    },
    icon: {
      rest: {
        rotate: 0,
        scale: 1,
        transition: { type: "spring", stiffness: 420, damping: 30, mass: 0.5 },
      },
      hover: {
        rotate: 28,
        scale: 1.18,
        transition: { type: "spring", stiffness: 520, damping: 18, mass: 0.45 },
      },
    },
  },
  settings: {
    button: {
      rest: { rotate: 0, scale: 1 },
      hover: { rotate: 3, scale: 1.04 },
    },
    icon: {
      rest: {
        rotate: 0,
        scale: 1,
        transition: { type: "spring", stiffness: 460, damping: 30, mass: 0.48 },
      },
      hover: {
        rotate: 90,
        scale: 1.1,
        transition: { type: "spring", stiffness: 560, damping: 23, mass: 0.44 },
      },
    },
  },
} as const;

/**
 * Bottom-of-sidebar utility cluster: an optional leading "switch
 * workspace" button (Dashboard ⇄ Capture), a single Light/Dark toggle,
 * and an optional Settings shortcut, all sharing one rounded pill.
 * Reads + writes the global theme store directly.
 *
 * The theme button renders against the surface fill with a subtle inset
 * shadow so the current choice is unambiguous. Hubs that surface
 * Settings as a dedicated sidebar row omit `onSettings`.
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
  const nextTheme = theme === "light" ? "dark" : "light";
  const themeToggleLabel =
    nextTheme === "dark" ? "Switch to dark theme" : "Switch to light theme";

  const handleThemeToggle = () => {
    // Mirror locally for instant feedback; persistence (when wired)
    // arrives via `onThemeChange` and pushes the same value back
    // through the settings change event.
    setTheme(nextTheme);
    onThemeChange?.(nextTheme);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-xl bg-[color:var(--color-overlay-1)] p-1",
        collapsed && "flex-col"
      )}
    >
      {onSwitch && SwitchIcon && (
        <UtilityButton
          action="switch"
          aria-label={switchLabel ?? "Switch window"}
          title={switchLabel}
          onClick={onSwitch}
          className={cn(
            BTN_BASE,
            "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          )}
          icon={SwitchIcon}
        />
      )}

      <UtilityButton
        action="theme"
        aria-label={themeToggleLabel}
        aria-pressed={theme === "dark"}
        title={themeToggleLabel}
        onClick={handleThemeToggle}
        className={cn(
          BTN_BASE,
          "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
        )}
      >
        <motion.span
          className="absolute inset-0 -z-10 rounded-md bg-[var(--color-surface)] shadow-[var(--shadow-subtle)]"
          layout
          transition={{ type: "spring", stiffness: 440, damping: 34 }}
        />
        <motion.span
          className="relative grid h-[15px] w-[15px] origin-center place-items-center"
          variants={UTILITY_MOTION.theme.icon}
        >
          <motion.span
            className="pointer-events-none absolute inset-0 grid place-items-center text-[var(--color-slate)]"
            variants={{
              rest: {
                opacity: 0,
                x: theme === "light" ? 9 : -9,
                y: theme === "light" ? 6 : -6,
                rotate: theme === "light" ? -38 : 38,
                scale: 0.42,
                transition: {
                  type: "spring",
                  stiffness: 430,
                  damping: 29,
                  mass: 0.45,
                },
              },
              hover: {
                opacity: 0.58,
                x: theme === "light" ? 8 : -8,
                y: theme === "light" ? 5 : -5,
                rotate: theme === "light" ? -14 : 14,
                scale: 0.7,
                transition: {
                  type: "spring",
                  stiffness: 520,
                  damping: 22,
                  mass: 0.42,
                },
              },
            }}
          >
            {nextTheme === "dark" ? (
              <Moon size={15} strokeWidth={1.85} />
            ) : (
              <Sun size={15} strokeWidth={1.85} />
            )}
          </motion.span>

          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={theme}
              initial={{
                opacity: 0,
                rotate: theme === "light" ? -70 : 70,
                scale: 0.5,
                y: theme === "light" ? 6 : -6,
              }}
              animate={{ opacity: 1, rotate: 0, scale: 1, y: 0 }}
              exit={{
                opacity: 0,
                rotate: theme === "light" ? 70 : -70,
                scale: 0.5,
                y: theme === "light" ? -6 : 6,
              }}
              transition={{
                type: "spring",
                stiffness: 520,
                damping: 24,
                mass: 0.46,
              }}
              className="absolute inset-0 grid place-items-center"
            >
              {theme === "light" ? (
                <Sun size={15} strokeWidth={1.85} />
              ) : (
                <Moon size={15} strokeWidth={1.85} />
              )}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      </UtilityButton>

      {onSettings && (
        <UtilityButton
          action="settings"
          aria-label="Open Settings"
          aria-pressed={settingsActive}
          onClick={onSettings}
          className={cn(
            BTN_BASE,
            settingsActive
              ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
              : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          )}
          icon={Settings}
        />
      )}
    </div>
  );
}

function UtilityButton({
  action,
  "aria-label": ariaLabel,
  "aria-pressed": ariaPressed,
  title,
  onClick,
  className,
  icon: Icon,
  children,
}: UtilityButtonProps) {
  const motionSpec = UTILITY_MOTION[action];

  return (
    <motion.button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      title={title}
      onClick={onClick}
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap={{ scale: 0.92 }}
      variants={motionSpec.button}
      transition={{ type: "spring", stiffness: 500, damping: 28, mass: 0.48 }}
      className={className}
    >
      {children}
      {Icon && (
        <motion.span
          className="grid origin-center place-items-center"
          variants={motionSpec.icon}
        >
          <Icon size={15} strokeWidth={1.85} />
        </motion.span>
      )}
    </motion.button>
  );
}
