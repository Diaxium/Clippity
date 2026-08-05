/**
 * Turning annotations into what the encoder composites.
 *
 * This is where the "one renderer" decision is cashed in. The export
 * does not describe annotations to the backend — it *draws* them, with
 * `drawAnnotations`, the same function that paints the live preview, on
 * a canvas the size of the source's frames. The backend receives PNGs
 * and alpha-blends them. So there is no second implementation of a text
 * callout or an arrowhead to disagree with the first, and no way for the
 * exported file to differ from what the user was looking at.
 *
 * The blur and pixelate kinds do not come through here at all: they
 * transform the pixels underneath, which an overlay cannot, so they
 * cross as parameters. See `redact.ts` and `toRedactions`.
 *
 * ## Why this is not one bitmap per frame
 *
 * An annotation holds one position for its whole range, so the picture
 * only changes when one starts or ends. `overlayIntervals` cuts the clip
 * at those boundaries; one overlay per span is enough, and spans where
 * nothing is showing need none. A clip with six annotations exports at
 * most thirteen bitmaps however long it runs.
 */

import type { Annotation, OverlayRef } from "@clippity/shared";

import { overlayIntervals } from "./annotations";
import { drawAnnotations } from "./drawAnnotations";

/** Strips the `data:image/png;base64,` prefix `toDataURL` produces. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/**
 * Render one interval's annotations to a PNG data URL, at native size.
 *
 * Split out so the canvas work can be driven by a test with a stub
 * factory — jsdom has no rasteriser, and what is worth checking here is
 * *how many* canvases get made and at what size, not what lands on them.
 */
export type CanvasFactory = (
  width: number,
  height: number
) => HTMLCanvasElement;

/** Real canvases, for the app. */
export const domCanvasFactory: CanvasFactory = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * Render and stage every overlay an export needs.
 *
 * `stage` is the IPC call that writes one PNG and returns its path;
 * injected rather than imported so this is testable without a backend.
 *
 * Returns the refs in clip order. An empty result is the normal case for
 * a clip with no drawn annotations, and means the encoder skips its
 * whole compositing step.
 */
export async function renderOverlays(
  annotations: readonly Annotation[],
  options: {
    /** Source frame size. Overlays must match it, or the backend
     *  composites only the overlap and logs the mismatch. */
    width: number;
    height: number;
    /** The exported range, on the **source** timeline. */
    fromMs: number;
    toMs: number;
    stage: (pngBase64: string) => Promise<string>;
    canvasFactory?: CanvasFactory;
  }
): Promise<OverlayRef[]> {
  const { width, height, fromMs, toMs, stage } = options;
  const factory = options.canvasFactory ?? domCanvasFactory;

  const intervals = overlayIntervals(annotations, fromMs, toMs);
  if (intervals.length === 0) return [];

  // One canvas, reused across intervals. `drawAnnotations` clears before
  // it draws, so there is nothing to carry over — and allocating a fresh
  // 5120×1440 canvas per interval would cost far more than it saves.
  const canvas = factory(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("could not render annotation overlays: no 2D context");
  }

  const refs: OverlayRef[] = [];
  for (const interval of intervals) {
    // Drawn at the interval's *start*, which is the moment the set is
    // constant from — any point inside it would give the same picture.
    drawAnnotations(ctx, annotations, interval.startMs, width, height);
    const path = await stage(base64Of(canvas.toDataURL("image/png")));
    refs.push({ path, startMs: interval.startMs, endMs: interval.endMs });
  }
  return refs;
}
