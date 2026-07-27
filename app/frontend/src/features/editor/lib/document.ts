/**
 * Editable-document (de)serialization. The on-disk format is a small JSON
 * envelope around the scene graph, written to a sidecar beside the capture
 * (`editorSaveScene`) and read back on open. The scene is self-contained —
 * image fills embed their base64 data URI — so a saved project survives even
 * if the source capture is later moved.
 *
 * Versioned so the format can evolve; `parseDocument` rejects anything it
 * doesn't recognize (the editor then falls back to seeding from the flat image),
 * so a corrupt or future-version sidecar never crashes the open path.
 */

import type { SceneNode } from "../types";

export const DOCUMENT_VERSION = 1;

export interface EditorDocument {
  version: number;
  docName: string;
  /** Top-level node ids, back-to-front (matches `SceneDoc.rootIds`). */
  rootIds: string[];
  nodes: Record<string, SceneNode>;
}

/** Fields of the store the document needs — kept structural so tests and the
 *  save hook can pass a plain object or the live store snapshot. */
export interface DocumentSource {
  docName: string;
  rootIds: string[];
  nodes: Record<string, SceneNode>;
}

export function serializeDocument(src: DocumentSource): string {
  const doc: EditorDocument = {
    version: DOCUMENT_VERSION,
    docName: src.docName,
    rootIds: src.rootIds,
    nodes: src.nodes,
  };
  return JSON.stringify(doc);
}

/** Parse a saved document, or `null` if it's malformed / an unknown version. */
export function parseDocument(json: string): EditorDocument | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const doc = data as Partial<EditorDocument>;
  if (
    doc.version !== DOCUMENT_VERSION ||
    !Array.isArray(doc.rootIds) ||
    !doc.nodes ||
    typeof doc.nodes !== "object"
  ) {
    return null;
  }
  return {
    version: DOCUMENT_VERSION,
    docName: typeof doc.docName === "string" ? doc.docName : "Untitled",
    rootIds: doc.rootIds as string[],
    nodes: doc.nodes as Record<string, SceneNode>,
  };
}
