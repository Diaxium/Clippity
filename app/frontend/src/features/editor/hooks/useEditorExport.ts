import { useCallback, useState } from "react";

import { editorSave } from "@services/tauri/clients/editor";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { flattenScene, type ExportFormat } from "../lib/render";
import { useEditorStore } from "../state/editorStore";

export interface ExportOptions {
  /** Pixel multiplier (1, 2, …). Defaults to 1. */
  scale?: number;
  /** Export only this node's subtree. Defaults to the whole page. */
  nodeId?: string | null;
  /** Encoding to save. Defaults to PNG. */
  format?: ExportFormat;
  /** Lossy-encoder quality, 0–1. Ignored for PNG. */
  quality?: number;
}

/**
 * Export actions shared by the top bar and the Export panel.
 * `exportImage` flattens the active page (or one node) to PNG/JPEG/WebP and
 * persists it as a new capture via the `editor_save` IPC, which reads the
 * format off the data URI to pick the file extension. `copyPng` puts the same
 * scene on the system clipboard. Both surface failures as an error toast.
 */
export function useEditorExport() {
  const [busy, setBusy] = useState(false);

  const flatten = useCallback(
    async (opts: ExportOptions): Promise<string | null> => {
      const s = useEditorStore.getState();
      if (s.rootIds.length === 0) return null;
      return flattenScene(s.nodes, s.rootIds, {
        scale: opts.scale ?? 1,
        nodeId: opts.nodeId ?? null,
        format: opts.format ?? "png",
        quality: opts.quality,
      });
    },
    []
  );

  const exportImage = useCallback(
    async (opts: ExportOptions = {}): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        const uri = await flatten(opts);
        if (uri) await editorSave(uri);
      } catch (err) {
        void emitErrorToast(
          err instanceof Error ? err.message : "Export failed."
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, flatten]
  );

  /** Always PNG: the async clipboard API only accepts `image/png` for
   *  images, so honouring a lossy export choice here would just fail. */
  const copyPng = useCallback(
    async (opts: ExportOptions = {}): Promise<void> => {
      if (busy) return;
      setBusy(true);
      try {
        const uri = await flatten({ ...opts, format: "png" });
        if (!uri) return;
        const blob = await (await fetch(uri)).blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob }),
        ]);
      } catch (err) {
        void emitErrorToast(
          err instanceof Error ? err.message : "Copy failed."
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, flatten]
  );

  return { busy, exportImage, copyPng };
}
