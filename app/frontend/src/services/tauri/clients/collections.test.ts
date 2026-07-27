import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    libraryUpdated: "clippity://library/updated",
    collectionsUpdated: "clippity://collections/updated",
  },
}));

import {
  collectionsAddMembers,
  collectionsCreate,
  collectionsList,
  collectionsRemove,
  collectionsRemoveMembers,
  collectionsRename,
  collectionsSetOrder,
  onCollectionsUpdated,
  type Collection,
} from "./collections";

const sample: Collection = {
  id: "col_1700000000000_0",
  name: "Onboarding",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
  members: ["/tmp/captures/a.png"],
};

describe("collectionsList", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes collections_list with no args", async () => {
    invokeMock.mockResolvedValueOnce([sample]);
    await expect(collectionsList()).resolves.toEqual([sample]);
    expect(invokeMock).toHaveBeenCalledWith("collections_list");
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("library: collection not found");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(collectionsList()).rejects.toBe(boom);
  });
});

describe("collection CRUD", () => {
  beforeEach(() => invokeMock.mockReset());

  it("collectionsCreate passes the name", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    await expect(collectionsCreate("Onboarding")).resolves.toEqual(sample);
    expect(invokeMock).toHaveBeenCalledWith("collections_create", {
      name: "Onboarding",
    });
  });

  it("collectionsRename passes id + name", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    await collectionsRename(sample.id, "Renamed");
    expect(invokeMock).toHaveBeenCalledWith("collections_rename", {
      id: sample.id,
      name: "Renamed",
    });
  });

  it("collectionsRemove passes the id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await collectionsRemove(sample.id);
    expect(invokeMock).toHaveBeenCalledWith("collections_remove", {
      id: sample.id,
    });
  });
});

describe("collection membership", () => {
  beforeEach(() => invokeMock.mockReset());

  it("collectionsAddMembers sends the capture id list", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    await collectionsAddMembers(sample.id, ["/tmp/captures/a.png"]);
    expect(invokeMock).toHaveBeenCalledWith("collections_add_members", {
      id: sample.id,
      captureIds: ["/tmp/captures/a.png"],
    });
  });

  it("collectionsRemoveMembers sends the capture id list", async () => {
    invokeMock.mockResolvedValueOnce({ ...sample, members: [] });
    await collectionsRemoveMembers(sample.id, ["/tmp/captures/a.png"]);
    expect(invokeMock).toHaveBeenCalledWith("collections_remove_members", {
      id: sample.id,
      captureIds: ["/tmp/captures/a.png"],
    });
  });

  it("collectionsSetOrder sends the whole intended order", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    await collectionsSetOrder(sample.id, ["/b.png", "/a.png"]);
    expect(invokeMock).toHaveBeenCalledWith("collections_set_order", {
      id: sample.id,
      captureIds: ["/b.png", "/a.png"],
    });
  });
});

describe("onCollectionsUpdated", () => {
  beforeEach(() => onMock.mockReset());

  it("subscribes to its own event, not the library's", () => {
    // A capture joining a collection changes no listing row; sharing
    // `library/updated` would make every library view refetch for it.
    const unsubscribe = vi.fn();
    onMock.mockReturnValueOnce(unsubscribe);
    const handler = vi.fn();
    const stop = onCollectionsUpdated(handler);
    const [name, wrapper] = onMock.mock.calls[0] ?? [];
    expect(name).toBe("clippity://collections/updated");
    (wrapper as (p: unknown) => void)({ ignored: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(stop).toBe(unsubscribe);
  });
});
