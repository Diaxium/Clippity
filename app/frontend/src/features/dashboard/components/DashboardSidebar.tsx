import type { ComponentType } from "react";

import { Focus, FolderOpen, Home, LayoutGrid, PenLine } from "lucide-react";
import { motion } from "motion/react";

import { useSettings, useSettingsPatch } from "@features/settings";
import { inferPrefFromExplicit } from "@features/settings/lib/theme";
import { showCaptureWindow } from "@services/tauri/clients/toast";
import { ThemeToggle } from "@shared/ui";
import { cn } from "@shared/lib/cn";

import type { DashboardView } from "../types";

interface NavItem {
  id: DashboardView;
  label: string;
  icon: ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
}

const ITEMS: readonly NavItem[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "editor", label: "Editor", icon: PenLine },
  { id: "library", label: "Library", icon: FolderOpen },
  { id: "presets", label: "Presets", icon: LayoutGrid },
];

const EXPANDED = 220;
const COLLAPSED = 84;

interface DashboardSidebarProps {
  active: DashboardView;
  onChange: (next: DashboardView) => void;
  collapsed: boolean;
}

/**
 * Dashboard nav rail. Springs between collapsed and expanded. The
 * cross-window "Capture" jump now lives in the bottom ThemeToggle pill
 * (the `onSwitch` button) rather than as a nav row, so this rail only
 * holds the dashboard's own views. Settings opens the (future) settings
 * view; for MVP it's the placeholder.
 */
export function DashboardSidebar({
  active,
  onChange,
  collapsed,
}: DashboardSidebarProps) {
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

  // Perf: the rail's width spring repaints every frame, and on the
  // transparent Mica window WebView2 software-rasterizes that paint — a
  // blurred drop-shadow here would re-rasterize its blur per frame (the
  // bulk of the collapse/expand CPU cost). A crisp hairline separates
  // the rail instead, and `will-change-transform` gives it its own
  // compositor layer so the repaint stays isolated from the content +
  // title bar rather than invalidating the whole window.
  return (
    <motion.aside
      animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
      initial={false}
      transition={{ type: "spring", stiffness: 360, damping: 34 }}
      className="sidebar-grad relative z-20 flex h-full shrink-0 flex-col border-r border-[color:var(--hairline)] p-3.5 will-change-transform"
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
                  layoutId="dashboard-nav-active"
                  className="absolute inset-0 -z-10 rounded-[10px] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]"
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                />
              )}
              {isActive && !collapsed && (
                <motion.span
                  layoutId="dashboard-nav-indicator"
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
          onSettings={() => onChange("settings")}
          settingsActive={active === "settings"}
          onThemeChange={persistTheme}
          onSwitch={() => void showCaptureWindow()}
          switchIcon={Focus}
          switchLabel="Open capture"
        />
      </div>
    </motion.aside>
  );
}
