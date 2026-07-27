/**
 * Build the initial scene for a freshly-opened capture: a clipping frame
 * sized to the image, with the bitmap as its single child. Mirrors the
 * reference design's "Image 1 ▸ Photo" layer structure.
 */

import type { EditorImage } from "@services/tauri/clients/editor";

import type { SceneInit } from "../state/editorStore";
import { makeFrame, makeImage, reseedNodeIds, type SceneNode } from "../types";
import { parseDocument } from "./document";

/** Strip directory + extension from a capture path for the document title. */
export function docNameFromId(id: string): string {
  const base = id.split(/[\\/]/).pop() ?? id;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() || "Image";
}

export function sceneFromImage(img: EditorImage): SceneInit {
  const rect = { x: 0, y: 0, width: img.width, height: img.height };
  const docName = docNameFromId(img.id);
  const frame = makeFrame(rect, {
    name: docName,
    clipContent: true,
    cornerRadius: 0,
  });
  const photo = makeImage(rect, img.dataUri, { name: "Photo" });
  frame.children = [photo.id];

  const nodes: Record<string, SceneNode> = {
    [frame.id]: frame,
    [photo.id]: photo,
  };
  return {
    rootIds: [frame.id],
    nodes,
    docName,
    sourceId: img.id,
    select: [frame.id],
  };
}

/**
 * Restore a previously-saved editable scene (the sidecar JSON returned by
 * `editorLoad`). Reseeds the id counter past the restored ids so new
 * nodes/paints can't collide. Returns `null` when the JSON is malformed or an
 * unknown version, so the caller can fall back to {@link sceneFromImage}.
 */
export function sceneFromSaved(json: string, id: string): SceneInit | null {
  const doc = parseDocument(json);
  if (!doc) return null;
  reseedNodeIds(doc.nodes);
  return {
    rootIds: doc.rootIds,
    nodes: doc.nodes,
    docName: doc.docName || docNameFromId(id),
    sourceId: id,
    select: [],
    status: "saved",
  };
}

/** A blank document for the "no capture loaded" path. */
export function emptyScene(): SceneInit {
  return { rootIds: [], nodes: {}, docName: "Untitled", sourceId: null };
}
