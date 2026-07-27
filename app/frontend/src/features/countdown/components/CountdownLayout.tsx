import { useCountdown } from "../hooks/useCountdown";
import { CountdownCancelHint } from "./CountdownCancelHint";
import { CountdownNumber } from "./CountdownNumber";
import { CountdownProgressBar } from "./CountdownProgressBar";

/**
 * Countdown HUD root. Mounted by `windows/CountdownWindow.tsx`. The
 * Tauri window is `transparent: true` + `decorations: false` so the
 * desktop wallpaper shows through wherever this component doesn't
 * paint pixels — that's why everything is anchored to the strip's
 * bottom edge (the rest stays see-through).
 *
 * Layout, top-to-bottom:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Press [Esc] to cancel                            3       │  ← row
 *   │ ████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← bar
 *   └──────────────────────────────────────────────────────────┘
 *   ███████████████ Windows taskbar ████████████████████████████
 *
 * Visual hierarchy (per the design spec): the number reads first
 * (bottom-right, large), the progress line second, the cancel hint
 * last (bottom-left, small + secondary).
 *
 * While the timer is idle the layout renders `null` so the window's
 * webview shows the wallpaper through — no flash of empty strip
 * during the cold-open before `start_countdown` fires.
 */
export function CountdownLayout() {
  const { remaining, progress, active } = useCountdown();

  if (!active || remaining === null) {
    return null;
  }

  return (
    <div className="flex h-screen w-screen select-none flex-col justify-end">
      <div className="flex items-end justify-between px-8 pb-2.5">
        <CountdownCancelHint />
        <CountdownNumber value={remaining} />
      </div>
      <CountdownProgressBar progress={progress} />
    </div>
  );
}
