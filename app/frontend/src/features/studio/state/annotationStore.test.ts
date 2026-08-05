import { beforeEach, describe, expect, it } from "vitest";

import { MIN_ANNOTATION_MS } from "../lib/annotations";
import { useStudioStore } from "./studioStore";
import type { MediaInfo } from "@services/tauri/clients/media";

const INFO: MediaInfo = {
  id: "C:/caps/Rec.mp4",
  token: 1,
  width: 1920,
  height: 1080,
  durationMs: 10_000,
  fps: 30,
  hasAudio: false,
};

/**
 * The annotation half of the store.
 *
 * The theme running through these: every edit reads the live state
 * inside the action rather than taking it as an argument. A component
 * computes its handler from the values it *rendered* with, so two rapid
 * edits in one tick would otherwise both start from the same stale
 * annotation and the second would undo the first — the same bug the
 * store's existing note on `stepFrames` describes.
 */
describe("studioStore annotations", () => {
  beforeEach(() => {
    useStudioStore.getState().reset();
    useStudioStore.getState().open(INFO.id);
    useStudioStore.getState().loaded(INFO);
  });

  const store = () => useStudioStore.getState();
  const only = () => store().annotations[0]!;

  it("adds an annotation at the playhead and selects it", () => {
    // A new annotation the user cannot immediately adjust is a shape
    // they have to go and find.
    store().seek(2_000);
    store().addAnnotation("box");

    expect(store().annotations).toHaveLength(1);
    expect(only().startMs).toBe(2_000);
    expect(store().selectedAnnotationId).toBe(only().id);
  });

  it("keeps an annotation added near the end inside the clip", () => {
    // Otherwise part of its bar sits past the end of the timeline and
    // cannot be grabbed.
    store().seek(9_900);
    store().addAnnotation("box");

    expect(only().endMs).toBeLessThanOrEqual(INFO.durationMs);
    expect(only().startMs).toBeLessThan(only().endMs);
  });

  it("patches only the annotation named", () => {
    store().addAnnotation("box");
    const first = only().id;
    store().addAnnotation("box");

    store().updateAnnotation(first, {
      rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    });
    expect(store().annotations[0]!.rect.x).toBe(0.5);
    expect(store().annotations[1]!.rect.x).not.toBe(0.5);
  });

  it("resolves an edge drag rather than trusting it", () => {
    // Routed through the shared resolver, so a drag can no more produce
    // an inverted range than a button press can.
    store().addAnnotation("box");
    const { id } = only();

    store().dragAnnotationEdge(id, "start", 99_000);
    expect(only().endMs - only().startMs).toBeGreaterThanOrEqual(
      MIN_ANNOTATION_MS
    );
    expect(only().endMs).toBeLessThanOrEqual(INFO.durationMs);
  });

  it("compounds successive range nudges", () => {
    // The stale-closure guarantee: three nudges must move three steps,
    // not one.
    store().seek(1_000);
    store().addAnnotation("box");
    const { id, startMs } = only();

    store().nudgeAnnotationRange(id, 100);
    store().nudgeAnnotationRange(id, 100);
    store().nudgeAnnotationRange(id, 100);

    expect(only().startMs).toBe(startMs + 300);
  });

  it("keeps a nudged range the length it was", () => {
    store().seek(1_000);
    store().addAnnotation("box");
    const { id } = only();
    const length = only().endMs - only().startMs;

    store().nudgeAnnotationRange(id, 99_000);
    expect(only().endMs - only().startMs).toBe(length);
    expect(only().endMs).toBeLessThanOrEqual(INFO.durationMs);
  });

  it("clears the selection when the selected annotation is deleted", () => {
    // A selected id with nothing behind it leaves the inspector
    // rendering a panel for an annotation that no longer exists.
    store().addAnnotation("box");
    const { id } = only();
    store().removeAnnotation(id);

    expect(store().annotations).toHaveLength(0);
    expect(store().selectedAnnotationId).toBeNull();
  });

  it("leaves the selection alone when a different one is deleted", () => {
    store().addAnnotation("box");
    const first = only().id;
    store().addAnnotation("text");
    const second = store().selectedAnnotationId;

    store().removeAnnotation(first);
    expect(store().selectedAnnotationId).toBe(second);
  });

  it("drops annotations when a different clip is opened", () => {
    // They are positioned against a picture that is no longer there.
    store().addAnnotation("box");
    store().open("C:/caps/Other.mp4");

    expect(store().annotations).toEqual([]);
    expect(store().selectedAnnotationId).toBeNull();
  });

  it("keeps annotations when the same clip is re-opened", () => {
    // The dashboard re-emits its view request on every cross-window
    // jump, including ones that land back here — the same reason the
    // trim range survives it.
    store().addAnnotation("box");
    store().open(INFO.id);

    expect(store().annotations).toHaveLength(1);
  });

  it("ignores edits naming an annotation that is not there", () => {
    store().addAnnotation("box");
    const before = store().annotations;

    store().dragAnnotationEdge("nope", "start", 500);
    store().nudgeAnnotationRange("nope", 500);
    store().updateAnnotation("nope", { startMs: 0 });

    expect(store().annotations).toEqual(before);
  });

  it("replaces the whole set without leaving a stale selection", () => {
    // How a sidecar load lands.
    store().addAnnotation("box");
    store().setAnnotations([]);
    expect(store().selectedAnnotationId).toBeNull();
  });
});
