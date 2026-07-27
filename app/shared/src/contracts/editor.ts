/**
 * Editor wire-format contracts — mirror Rust `domain::editor`.
 *
 * Per-annotation types live entirely in `features/editor/` because the
 * backend treats them as opaque pixels baked into the saved PNG.
 */

/** What `editor_load` returns. `dataUri` is consumable by `<img>` and
 *  Canvas2D without an extra fetch. */
export interface EditorImage {
  /** Echo of the id that was loaded (= absolute path on disk). */
  id: string;
  dataUri: string;
  width: number;
  height: number;
  /** The saved editable scene (a JSON document) if a sidecar exists for
   *  this capture; `null` otherwise. When present the editor restores the
   *  editable scene instead of re-seeding from the flattened image. */
  scene: string | null;
}
