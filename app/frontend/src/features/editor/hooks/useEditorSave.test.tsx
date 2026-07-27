import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@services/tauri/clients/editor", () => ({
  editorSaveScene: vi.fn(),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: vi.fn(),
}));

import { editorSaveScene } from "@services/tauri/clients/editor";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { useEditorStore } from "../state/editorStore";
import { __resetNodeIdForTests, makeRectangle, type SceneNode } from "../types";
import { useEditorSave } from "./useEditorSave";

const saveMock = editorSaveScene as unknown as ReturnType<typeof vi.fn>;
const toastMock = emitErrorToast as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  saveMock.mockReset().mockResolvedValue("/caps/.scenes/x.png.json");
  toastMock.mockReset();
  __resetNodeIdForTests();
  const a = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
  const nodes: Record<string, SceneNode> = { [a.id]: a };
  useEditorStore
    .getState()
    .loadScene({ rootIds: [a.id], nodes, docName: "Doc", sourceId: "/caps/x.png" });
});

describe("useEditorSave", () => {
  it("serializes the scene to editor_save_scene and marks the doc saved", async () => {
    const { result } = renderHook(() => useEditorSave());
    await act(async () => {
      await result.current.save();
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
    const [id, json] = saveMock.mock.calls[0]!;
    expect(id).toBe("/caps/x.png");
    expect(JSON.parse(json as string).version).toBe(1);
    expect(useEditorStore.getState().docStatus).toBe("saved");
  });

  it("toasts and skips the IPC when there is no source capture", async () => {
    useEditorStore
      .getState()
      .loadScene({ rootIds: [], nodes: {}, docName: "Untitled", sourceId: null });
    const { result } = renderHook(() => useEditorSave());
    await act(async () => {
      await result.current.save();
    });
    expect(saveMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().docStatus).not.toBe("saved");
  });
});
