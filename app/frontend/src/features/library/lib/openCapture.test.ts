import { beforeEach, describe, expect, it, vi } from "vitest";

// Both resolve: `openCapture` chains `.catch` onto what they return, so
// a bare `vi.fn()` handing back `undefined` would fail on the mock
// rather than on the code.
vi.mock("@services/tauri/clients/editor", () => ({
  openInEditor: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/media", () => ({
  openInStudio: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/toast", () => ({ emitErrorToast: vi.fn() }));

import { openInEditor } from "@services/tauri/clients/editor";
import { openInStudio } from "@services/tauri/clients/media";

import { openCapture, openLabelFor, openSurfaceFor } from "./openCapture";
import type { CaptureMeta } from "../types";

function meta(patch: Partial<CaptureMeta> = {}): CaptureMeta {
  return {
    id: "C:/caps/a.png",
    name: "a.png",
    kind: "image",
    createdAtMs: 0,
    sizeBytes: 1,
    ...patch,
  } as CaptureMeta;
}

const video = meta({ id: "C:/caps/a.mp4", kind: "video" });
const gif = meta({ id: "C:/caps/a.gif", kind: "gif" });

/**
 * The rule that drifted.
 *
 * Studio's routing was added to the context menu and the Inspector but
 * missed on the card's own double-click, so opening a recording that way
 * handed a `.mp4` to the annotation editor and failed with a decoder
 * error. Three copies of one rule; two of them right.
 *
 * These test the rule rather than any one of its callers, which is what
 * makes them cover all three.
 */
describe("openSurfaceFor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a recording to Studio", () => {
    expect(openSurfaceFor(video)).toBe("studio");
  });

  it("sends a still to the editor", () => {
    expect(openSurfaceFor(meta())).toBe("editor");
  });

  it("sends a GIF to the editor, not Studio", () => {
    // GIF decodes as an image, so the editor genuinely works on it and
    // flattening the animation is the user's choice. The reverse is not
    // true: Studio's platform decoder will not seek a GIF.
    expect(openSurfaceFor(gif)).toBe("editor");
  });

  it("labels the action for the surface it will actually use", () => {
    expect(openLabelFor(video)).toBe("Open in Studio");
    expect(openLabelFor(meta())).toBe("Open in editor");
  });
});

describe("openCapture", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a recording in Studio and never in the editor", () => {
    // The editor loads a capture as an image; handing it a video is the
    // exact call that produced "not an image file".
    openCapture(video);
    expect(openInStudio).toHaveBeenCalledWith(video.id);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("opens a still in the editor and never in Studio", () => {
    openCapture(meta());
    expect(openInEditor).toHaveBeenCalledWith("C:/caps/a.png");
    expect(openInStudio).not.toHaveBeenCalled();
  });

  it("opens a GIF in the editor", () => {
    openCapture(gif);
    expect(openInEditor).toHaveBeenCalledWith(gif.id);
    expect(openInStudio).not.toHaveBeenCalled();
  });
});
