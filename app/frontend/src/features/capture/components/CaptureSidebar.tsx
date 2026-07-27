import { motion } from "motion/react";
import { Clock, Focus, LayoutDashboard, LayoutGrid, Video } from "lucide-react";
import type { ComponentType } from "react";

import { useSettings, useSettingsPatch } from "@features/settings";
import { inferPrefFromExplicit } from "@features/settings/lib/theme";
import { openDashboard } from "@services/tauri/clients/dashboard";
import { ThemeToggle } from "@shared/ui";
import { cn } from "@shared/lib/cn";

import type { CaptureNav } from "../types";

const ITEMS: readonly {
  id: CaptureNav;
  label: string;
  icon: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
}[] = [
  { id: "capture", label: "Capture", icon: Focus },
  { id: "record", label: "Record", icon: Video },
  { id: "history", label: "History", icon: Clock },
  { id: "presets", label: "Presets", icon: LayoutGrid },
];

const EXPANDED = 220;
const COLLAPSED = 84;

interface CaptureSidebarProps {
  active: CaptureNav;
  onChange: (next: CaptureNav) => void;
  onOpenSettings: () => void;
  collapsed: boolean;
}

/**
 * Capture window's left nav rail. Springs between collapsed (icon-only)
 * and expanded (icon + label). Bottom of the rail anchors theme + a
 * Settings shortcut.
 */
export function CaptureSidebar({
  active,
  onChange,
  onOpenSettings,
  collapsed,
}: CaptureSidebarProps) {
  const settings = useSettings();
  const patch = useSettingsPatch();
  const persistTheme = (next: "light" | "dark") => {
    if (!settings) return;
    const osPrefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const nextPref = inferPrefFromExplicit(
      settings.appearance.theme,
      next,
      osPrefersDark
    );
    if (nextPref === settings.appearance.theme) return;
    patch({
      appearance: { ...settings.appearance, theme: nextPref },
    });
  };

  return (
    <motion.aside
      animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
      initial={false}
      transition={{ type: "spring", stiffness: 360, damping: 34 }}
      className="sidebar-grad relative z-20 flex h-full shrink-0 flex-col p-3.5 shadow-[var(--shadow-medium)]"
    >
      <nav className="flex flex-col gap-1.5">
        {ITEMS.map(({ id, label, icon: Icon }) => {
          const isActive = id === active;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              aria-pressed={isActive}
              title={collapsed ? label : undefined}
              className={cn(
                "focus-ring relative flex h-[44px] items-center rounded-[10px] text-[13px] font-medium transition-colors duration-200",
                collapsed ? "justify-center px-0" : "gap-3 px-3.5",
                isActive
                  ? "text-[var(--color-accent)]"
                  : "text-[var(--color-slate)] hover:text-[var(--color-ink)]"
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="capture-nav-active"
                  className="absolute inset-0 -z-10 rounded-[10px] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              {isActive && !collapsed && (
                <motion.span
                  layoutId="capture-nav-indicator"
                  className="absolute left-0 h-5 w-[3px] rounded-full bg-[var(--color-accent)]"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              <Icon size={20} strokeWidth={1.75} />
              {!collapsed && <span>{label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex justify-center pb-1">
        <ThemeToggle
          collapsed={collapsed}
          onSettings={onOpenSettings}
          onThemeChange={persistTheme}
          onSwitch={() => void openDashboard("library")}
          switchIcon={LayoutDashboard}
          switchLabel="Open dashboard"
        />
      </div>
    </motion.aside>
  );
}
