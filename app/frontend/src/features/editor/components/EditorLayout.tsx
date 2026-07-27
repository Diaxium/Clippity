import { useEffect, useMemo } from "react";

import { editorLoad } from "@services/tauri/clients/editor";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { useEditorKeybinds, type KeybindApi } from "../keybinds";
import { useEditorExport } from "../hooks/useEditorExport";
import { useEditorSave } from "../hooks/useEditorSave";
import { emptyScene, sceneFromImage, sceneFromSaved } from "../lib/seed";
import { useEditorStore } from "../state/editorStore";
import { DockDropZone, FloatingInspector } from "./FloatingInspector";
import { InspectorPanel } from "./InspectorPanel";
import { EditorCanvas } from "./EditorCanvas";
import { ColorPopover } from "./ColorPopover";
import { EditorContextMenu } from "./EditorContextMenu";
import { EditorEmpty } from "./EditorEmpty";
import { EditorTopBar } from "./EditorTopBar";
import { KeybindHelpOverlay } from "./KeybindHelpOverlay";
import { LeftPanel } from "./LeftPanel";

interface EditorLayoutProps {
  /** Capture id (= file path) to load. Null renders the empty state. */
  id: string | null;
  /** Dashboard navigation to the Library — surfaces a CTA in the
   *  empty state so "open a capture" is a click, not a hunt. */
  onOpenLibrary?: () => void;
}

/**
 * Editor root — mounted by the dashboard when its view is "editor". Loads the
 * capture into the scene store, owns window-level keyboard shortcuts, and
 * composes the Figma-style surface (top bar · left panel · canvas · right
 * panel) inside the always-dark `.clippity-editor` token scope.
 */
export function EditorLayout({ id, onOpenLibrary }: EditorLayoutProps) {
  // Layers panel is Design-mode only — Annotation mode hides it (Workstream M2).
  const mode = useEditorStore((s) => s.mode);
  const dock = useEditorStore((s) => s.inspectorDock[mode]);

  // File/clipboard shortcuts (Mod+E / Mod+Shift+C / Mod+S …) reuse the same
  // export + save pipelines the top bar / doc menu drive, so there is one
  // source of truth.
  const { exportImage, copyPng } = useEditorExport();
  const { save } = useEditorSave();
  const api = useMemo<KeybindApi>(
    () => ({
      exportImage: () => void exportImage(),
      copyFlattened: () => void copyPng(),
      exportOptions: () => useEditorStore.getState().requestExport(),
      toggleHelp: () => useEditorStore.getState().toggleHelp(),
      // Mod+S / Mod+Shift+S persist the editable scene as a sidecar; re-opening
      // the capture restores it. (Mod+E still exports a flattened PNG.)
      saveDocument: () => void save(),
    }),
    [exportImage, copyPng, save]
  );
  useEditorKeybinds(id != null, api);

  useEffect(() => {
    let cancelled = false;
    if (!id) {
      useEditorStore.getState().loadScene(emptyScene());
      return;
    }
    void (async () => {
      try {
        const img = await editorLoad(id);
        if (cancelled) return;
        // Restore the editable scene if a saved sidecar came back; otherwise
        // (or if it's malformed) seed a fresh scene from the flat image.
        const restored = img.scene ? sceneFromSaved(img.scene, id) : null;
        useEditorStore.getState().loadScene(restored ?? sceneFromImage(img));
      } catch (err) {
        if (cancelled) return;
        void emitErrorToast(
          err instanceof Error ? err.message : "Failed to open capture."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <EditorEmpty onOpenLibrary={onOpenLibrary} />;

  // No blanket `onContextMenu` on the root any more: suppressing the
  // WebView2 menu is done once, globally, in the capture phase (see
  // `useNativeContextMenu`). Swallowing the event here as well would cost
  // the inspector's text fields their Cut/Copy/Paste menu, since that
  // comes from the window-level fallback. The canvas and the layer rows
  // claim their own clicks before it ever gets there.
  return (
    <div className="clippity-editor isolate flex h-full w-full flex-col overflow-hidden">
      <EditorTopBar />
      <div className="flex min-h-0 flex-1">
        {mode === "design" && <LeftPanel />}
        {/* The inspector is one component in two shapes: a rail docked to an
            edge, or a panel floating over the canvas. Which one is per-mode
            state the user can drag between (see lib/dock.ts). */}
        {dock === "left" && <InspectorPanel mode={mode} side="left" />}
        {/* Marked so the floating color editor can center itself over the
            canvas instead of crowding the inspector. */}
        <div data-canvas-area className="relative min-w-0 flex-1">
          <EditorCanvas />
          {dock === null && <FloatingInspector mode={mode} />}
          <DockDropZone />
        </div>
        {dock === "right" && <InspectorPanel mode={mode} side="right" />}
      </div>
      <EditorContextMenu />
      <ColorPopover />
      <KeybindHelpOverlay />
    </div>
  );
}
