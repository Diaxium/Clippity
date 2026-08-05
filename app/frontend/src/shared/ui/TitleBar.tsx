import type { ReactNode } from "react";
import { Minus, PanelLeftClose, PanelLeftOpen, Square, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { cn } from "@shared/lib/cn";

import { Brand } from "./Brand";

interface TitleBarProps {
  /** Optional subtitle/breadcrumb to the right of the brand. */
  title?: string;
  /** Sidebar/menu toggle. Hidden when omitted. */
  onMenu?: () => void;
  /**
   * Whether the sidebar this toggle controls is currently expanded.
   * Drives the toggle's animated icon (panel-close when open →
   * panel-open when collapsed) and the button's `aria-expanded`.
   */
  sidebarOpen?: boolean;
  /** Hide the Brand mark (e.g. for the overlay window which is chromeless). */
  hideBrand?: boolean;
  /** Optional content rendered after the brand/title (e.g. the editor's
   *  document title control). Sits inside the drag region; opt out with
   *  `.no-drag` on interactive children. */
  children?: ReactNode;
  className?: string;
}

type WindowAction = "minimize" | "maximize" | "close";

interface WindowActionButtonProps {
  action: WindowAction;
  icon: LucideIcon;
  iconSize: number;
  label: string;
  onClick: () => void;
}

const WINDOW_ACTION_MOTION = {
  minimize: {
    button: {
      rest: { y: 0, scale: 1 },
      hover: { y: 1, scale: 1.02 },
    },
    icon: {
      rest: {
        y: 0,
        scaleX: 1,
        opacity: 1,
        transition: { duration: 0.18, ease: "easeOut" },
      },
      hover: {
        y: 3,
        scaleX: 1.28,
        opacity: 0.92,
        transition: { type: "spring", stiffness: 520, damping: 20, mass: 0.45 },
      },
    },
  },
  maximize: {
    button: {
      rest: { scale: 1, rotate: 0 },
      hover: { scale: 1.04, rotate: -2 },
    },
    icon: {
      rest: {
        scale: 1,
        rotate: 0,
        transition: { type: "spring", stiffness: 420, damping: 28, mass: 0.5 },
      },
      hover: {
        scale: 1.18,
        rotate: 90,
        transition: { type: "spring", stiffness: 470, damping: 24, mass: 0.55 },
      },
    },
  },
  close: {
    button: {
      rest: { scale: 1, rotate: 0 },
      hover: { scale: 1.06, rotate: 1.5 },
    },
    icon: {
      rest: {
        scale: 1,
        rotate: 0,
        transition: { type: "spring", stiffness: 500, damping: 30, mass: 0.45 },
      },
      hover: {
        scale: 1.15,
        rotate: 90,
        transition: { type: "spring", stiffness: 560, damping: 21, mass: 0.5 },
      },
    },
  },
} as const;

/**
 * Custom title bar for the app's borderless Tauri windows.
 *
 * The whole bar is the drag region; buttons opt out via `.no-drag` so
 * click targets don't trigger window-drag. Window controls call
 * `@tauri-apps/api/window` directly; in browser preview these fail
 * silently (caught by the `void` cast — there's no recovery path
 * worth surfacing).
 *
 * Layout: [Sidebar toggle] [Brand] [optional title] [flex spacer] [Minimize]
 * [Maximize] [Close]. The flex spacer keeps the drag region wide so
 * users can grab the empty middle to drag the window.
 */
export function TitleBar({
  title,
  onMenu,
  sidebarOpen = false,
  hideBrand = false,
  children,
  className,
}: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "drag-region flex h-10 shrink-0 items-center gap-1.5 px-1.5",
        className
      )}
    >
      {onMenu && (
        <motion.button
          type="button"
          onClick={onMenu}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-expanded={sidebarOpen}
          whileTap={{ scale: 0.88 }}
          className="no-drag focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
        >
          {/* Animated toggle state: the panel glyph morphs between
              "close" (chevron ◁, sidebar expanded) and "open" (chevron ▷,
              sidebar collapsed) so the button visibly reflects which
              state the nav rail is in. Keyed swap → AnimatePresence
              crossfades + spins the two glyphs in place. */}
          <span className="relative grid h-[15px] w-[15px] place-items-center">
            <AnimatePresence initial={false}>
              <motion.span
                key={sidebarOpen ? "open" : "collapsed"}
                initial={{ opacity: 0, rotate: -40, scale: 0.5 }}
                animate={{ opacity: 1, rotate: 0, scale: 1 }}
                exit={{ opacity: 0, rotate: 40, scale: 0.5 }}
                transition={{
                  type: "spring",
                  stiffness: 500,
                  damping: 30,
                  mass: 0.6,
                }}
                className="absolute inset-0 grid place-items-center"
              >
                {sidebarOpen ? (
                  <PanelLeftClose size={15} strokeWidth={1.85} />
                ) : (
                  <PanelLeftOpen size={15} strokeWidth={1.85} />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
        </motion.button>
      )}

      {!hideBrand && (
        <span className="no-drag ml-1 flex items-center">
          <Brand size={20} />
        </span>
      )}

      {title && (
        <span className="ml-2 text-[12px] font-medium text-[var(--color-hint)]">
          {title}
        </span>
      )}

      {children && <span className="ml-2 flex items-center">{children}</span>}

      <span className="flex-1" data-tauri-drag-region />

      <WindowActionButton
        action="minimize"
        icon={Minus}
        iconSize={14}
        label="Minimize"
        onClick={() => {
          void getCurrentWindow().minimize();
        }}
      />
      <WindowActionButton
        action="maximize"
        icon={Square}
        iconSize={12}
        label="Maximize"
        onClick={() => {
          void getCurrentWindow().toggleMaximize();
        }}
      />
      <WindowActionButton
        action="close"
        icon={X}
        iconSize={14}
        label="Close"
        onClick={() => {
          void getCurrentWindow().close();
        }}
      />
    </header>
  );
}

function WindowActionButton({
  action,
  icon: Icon,
  iconSize,
  label,
  onClick,
}: WindowActionButtonProps) {
  const motionSpec = WINDOW_ACTION_MOTION[action];

  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={label}
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap={{ scale: 0.92 }}
      variants={motionSpec.button}
      transition={{ type: "spring", stiffness: 520, damping: 28, mass: 0.5 }}
      className={cn(
        "no-drag focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-slate)] transition-colors",
        action === "close"
          ? "hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
          : "hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      <motion.span
        className="grid origin-center place-items-center"
        variants={motionSpec.icon}
      >
        <Icon size={iconSize} strokeWidth={1.85} />
      </motion.span>
    </motion.button>
  );
}
