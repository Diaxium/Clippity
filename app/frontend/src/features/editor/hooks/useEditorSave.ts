import { useCallback, useState } from "react";

import { editorSaveScene } from "@services/tauri/clients/editor";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { serializeDocument } from "../lib/document";
import { useEditorStore } from "../state/editorStore";

/**
 * Save the editable scene as a sidecar beside the open capture (Mod+S, and the
 * document menu's Save item). Serializes the live scene graph + name and
 * persists it via `editor_save_scene`, then marks the document saved. Surfaces
 * failures (and "no capture to save") as a non-blocking toast. Shared so the
 * keybind and the menu drive one implementation.
 */
export function useEditorSave() {
  const [saving, setSaving] = useState(false);

  const save = useCallback(async (): Promise<void> => {
    if (saving) return;
    const s = useEditorStore.getState();
    if (!s.sourceId) {
      void emitErrorToast("Open a capture before saving a project.");
      return;
    }
    setSaving(true);
    try {
      await editorSaveScene(s.sourceId, serializeDocument(s));
      useEditorStore.getState().markSaved();
    } catch (err) {
      void emitErrorToast(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [saving]);

  return { saving, save };
}
