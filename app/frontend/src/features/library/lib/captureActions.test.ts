import { describe, expect, it, vi } from "vitest";

vi.mock("@services/tauri/clients/editor", () => ({ openInEditor: vi.fn() }));
vi.mock("@services/tauri/clients/share", () => ({ shareCapture: vi.fn() }));
vi.mock("@services/tauri/clients/dashboard", () => ({
  openDashboard: vi.fn(),
}));
vi.mock("@services/tauri/clients/toast", () => ({ emitErrorToast: vi.fn() }));
vi.mock("./auxClipboard", () => ({ copyAux: vi.fn() }));
vi.mock("./labelActions", () => ({ setFavorite: vi.fn() }));

import { captureActionEntries } from "./captureActions";
import type { CaptureMeta } from "../types";

const handlers = {
  onDelete: vi.fn(),
  onRestore: vi.fn(),
  onPurge: vi.fn(),
};

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

/** Ids of the entries offered, skipping dividers. */
function ids(m: CaptureMeta): string[] {
  return captureActionEntries(m, "library", handlers)
    .filter((e): e is Exclude<typeof e, "divider"> => e !== "divider")
    .map((e) => e.id);
}

describe("captureActionEntries", () => {
  it("offers the editor for a still image", () => {
    expect(ids(meta())).toContain("open-editor");
  });

  it("sends a recording to Studio instead of the editor", () => {
    // The annotation editor loads a capture as an image, and a video is
    // not one — so a recording gets the surface that can actually play
    // and trim it, not a disabled entry and not one that always errors.
    const entries = ids(meta({ id: "C:/caps/a.mp4", kind: "video" }));
    expect(entries).toContain("open-studio");
    expect(entries).not.toContain("open-editor");
    // …and is still openable and revealable through the OS.
    expect(entries).toContain("open-default");
    expect(entries).toContain("reveal");
  });

  it("still offers the editor for a GIF, and not Studio", () => {
    // GIF decodes as an image, so the editor genuinely works on it —
    // flattening the animation is a choice the user gets to make. The
    // reverse is not true: Studio's platform decoder will not seek a
    // GIF, so an entry pointing there would open a player that can't
    // scrub.
    const entries = ids(meta({ id: "C:/caps/a.gif", kind: "gif" }));
    expect(entries).toContain("open-editor");
    expect(entries).not.toContain("open-studio");
  });

  it("offers neither editor nor reveal for aux kinds", () => {
    // No file on disk to reveal and nothing to annotate.
    const entries = ids(meta({ kind: "color" }));
    expect(entries).not.toContain("open-editor");
    expect(entries).not.toContain("reveal");
    expect(entries).toContain("copy");
  });

  it("offers only restore and purge in the trash, whatever the kind", () => {
    for (const kind of ["image", "video", "gif"] as const) {
      const entries = captureActionEntries(meta({ kind }), "trash", handlers)
        .filter((e): e is Exclude<typeof e, "divider"> => e !== "divider")
        .map((e) => e.id);
      expect(entries).toEqual(["restore", "purge"]);
    }
  });
});
