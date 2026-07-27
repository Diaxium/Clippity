import { LayersTree } from "./LayersTree";

/**
 * Left rail of the editor — a fixed column hosting the scene's layer tree.
 * (Pages/Assets were intentionally dropped: this is a single-capture editor,
 * not a multi-page design tool, so they served no purpose here.) Its header
 * shares the inspector's `h-9` band so the chrome lines up under the top bar.
 */
export function LeftPanel() {
  return (
    <div className="flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-[color:var(--ed-hairline)] bg-[var(--ed-panel)]">
      <div className="flex h-9 shrink-0 items-center border-b border-[color:var(--ed-hairline)] px-3.5 text-[12px] font-medium text-[var(--ed-text)]">
        Layers
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LayersTree />
      </div>
    </div>
  );
}
