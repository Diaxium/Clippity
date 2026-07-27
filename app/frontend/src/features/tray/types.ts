/**
 * Tray feature — frontend-local view types. Wire types come from the
 * shared IPC clients (`services/tauri/clients/*`); these shapes exist
 * only inside the panel.
 */

/** A recent capture rendered as a thumbnail tile in the panel. */
export interface RecentCapture {
  /** Absolute-path id (stable across IPC); also the editor-open arg. */
  id: string;
  /** File-stem title — the thumbnail's accessible label. */
  title: string;
  /** Base64 PNG data URI, or `null` while the thumbnail is decoding. */
  thumb: string | null;
}
