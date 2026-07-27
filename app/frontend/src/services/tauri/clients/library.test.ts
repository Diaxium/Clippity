import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    onboardingComplete: "clippity://onboarding-complete",
    captureFinished: "clippity://capture/finished",
    overlayShown: "clippity://overlay/shown",
    overlayToggles: "clippity://overlay/toggles",
    toastShow: "clippity://toast/show",
    toastHide: "clippity://toast/hide",
    libraryUpdated: "clippity://library/updated",
    settingsChanged: "clippity://settings/changed",
  },
}));

import {
  libraryAddTags,
  libraryDelete,
  libraryFacets,
  libraryList,
  libraryPurge,
  libraryRemoveTags,
  libraryRestore,
  librarySetFavorite,
  librarySetTags,
  libraryStorage,
  libraryThumbnail,
  onLibraryUpdated,
  type CaptureMeta,
} from "./library";

const sampleMeta: CaptureMeta = {
  id: "/tmp/captures/clippity-1.png",
  title: "clippity-1",
  kind: "image",
  createdAtMs: 1_700_000_000_000,
  sizeBytes: 4096,
  trashed: false,
};

describe("libraryList", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes library_list with the includeTrashed flag", async () => {
    invokeMock.mockResolvedValueOnce([sampleMeta]);
    await expect(libraryList(true)).resolves.toEqual([sampleMeta]);
    expect(invokeMock).toHaveBeenCalledWith("library_list", {
      includeTrashed: true,
    });
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("library: scan failed");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(libraryList(false)).rejects.toBe(boom);
  });
});

describe("libraryFacets", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes library_facets with the caller's smart thresholds", async () => {
    const facets = {
      total: 3,
      kinds: { image: 3 },
      favorites: 1,
      trashed: 2,
      tags: [{ tag: "bug", count: 1 }],
      smart: { thisWeek: 3, last30Days: 3, large: 0, untagged: 2 },
    };
    invokeMock.mockResolvedValueOnce(facets);
    const query = {
      thisWeekSinceMs: 1_700_000_000_000,
      last30DaysSinceMs: 1_690_000_000_000,
      largeMinBytes: 5_242_880,
    };
    await expect(libraryFacets(query)).resolves.toEqual(facets);
    expect(invokeMock).toHaveBeenCalledWith("library_facets", { query });
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("library: index facet counts failed");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(
      libraryFacets({
        thisWeekSinceMs: 0,
        last30DaysSinceMs: 0,
        largeMinBytes: 0,
      })
    ).rejects.toBe(boom);
  });
});

describe("libraryThumbnail", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes library_thumbnail with id + maxWidth", async () => {
    invokeMock.mockResolvedValueOnce("data:image/png;base64,abc");
    await libraryThumbnail("/tmp/captures/clippity-1.png", 480);
    expect(invokeMock).toHaveBeenCalledWith("library_thumbnail", {
      id: "/tmp/captures/clippity-1.png",
      maxWidth: 480,
    });
  });
});

describe("libraryDelete / libraryRestore / libraryPurge", () => {
  beforeEach(() => invokeMock.mockReset());

  it("libraryDelete invokes library_delete + returns the new id", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/captures/.trash/clippity-1.png");
    const next = await libraryDelete("/tmp/captures/clippity-1.png");
    expect(invokeMock).toHaveBeenCalledWith("library_delete", {
      id: "/tmp/captures/clippity-1.png",
    });
    expect(next).toBe("/tmp/captures/.trash/clippity-1.png");
  });

  it("libraryRestore invokes library_restore", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/captures/clippity-1.png");
    await libraryRestore("/tmp/captures/.trash/clippity-1.png");
    expect(invokeMock).toHaveBeenCalledWith("library_restore", {
      id: "/tmp/captures/.trash/clippity-1.png",
    });
  });

  it("libraryPurge invokes library_purge", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await libraryPurge("/tmp/captures/.trash/clippity-1.png");
    expect(invokeMock).toHaveBeenCalledWith("library_purge", {
      id: "/tmp/captures/.trash/clippity-1.png",
    });
  });
});

describe("libraryStorage", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes library_storage with no args", async () => {
    invokeMock.mockResolvedValueOnce({ usedBytes: 100, totalBytes: 200 });
    await libraryStorage();
    expect(invokeMock).toHaveBeenCalledWith("library_storage");
  });
});

describe("label commands", () => {
  beforeEach(() => invokeMock.mockReset());

  it("librarySetFavorite sends the id list and the flag", async () => {
    invokeMock.mockResolvedValueOnce(2);
    await expect(
      librarySetFavorite(["/tmp/a.png", "/tmp/b.png"], true)
    ).resolves.toBe(2);
    expect(invokeMock).toHaveBeenCalledWith("library_set_favorite", {
      ids: ["/tmp/a.png", "/tmp/b.png"],
      favorite: true,
    });
  });

  it("a single-capture edit is the same call as a bulk one", async () => {
    // The plural argument is the whole point: the UI never fans out N
    // round trips for a selection.
    invokeMock.mockResolvedValueOnce(1);
    await libraryAddTags(["/tmp/a.png"], ["bug"]);
    expect(invokeMock).toHaveBeenCalledWith("library_add_tags", {
      ids: ["/tmp/a.png"],
      tags: ["bug"],
    });
  });

  it("libraryRemoveTags and librarySetTags route to their own commands", async () => {
    invokeMock.mockResolvedValueOnce(1);
    await libraryRemoveTags(["/tmp/a.png"], ["bug"]);
    expect(invokeMock).toHaveBeenLastCalledWith("library_remove_tags", {
      ids: ["/tmp/a.png"],
      tags: ["bug"],
    });
    invokeMock.mockResolvedValueOnce(1);
    await librarySetTags(["/tmp/a.png"], ["docs"]);
    expect(invokeMock).toHaveBeenLastCalledWith("library_set_tags", {
      ids: ["/tmp/a.png"],
      tags: ["docs"],
    });
  });

  it("resolves to how many entries actually changed", async () => {
    // Zero means the edit asked for what was already true — nothing was
    // written and no refresh event fired.
    invokeMock.mockResolvedValueOnce(0);
    await expect(libraryAddTags(["/tmp/a.png"], ["bug"])).resolves.toBe(0);
  });
});

describe("onLibraryUpdated", () => {
  beforeEach(() => onMock.mockReset());

  it("subscribes to the library/updated event with a wrapper handler", () => {
    const unsubscribe = vi.fn();
    onMock.mockReturnValueOnce(unsubscribe);
    const handler = vi.fn();
    const stop = onLibraryUpdated(handler);
    expect(onMock).toHaveBeenCalledTimes(1);
    const [name, wrapper] = onMock.mock.calls[0] ?? [];
    expect(name).toBe("clippity://library/updated");
    expect(typeof wrapper).toBe("function");
    // The wrapper drops the payload and calls the user handler.
    (wrapper as (p: unknown) => void)({ ignored: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(stop).toBe(unsubscribe);
  });
});
