import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const openDashboardMock = vi.fn();

vi.mock("./dashboard", () => ({
  openDashboard: (...args: unknown[]) => openDashboardMock(...args),
}));

import {
  editorLoad,
  editorSave,
  editorSaveScene,
  openInEditor,
  type EditorImage,
} from "./editor";

const sample: EditorImage = {
  id: "/tmp/captures/clippity-1.png",
  dataUri: "data:image/png;base64,abc",
  width: 1920,
  height: 1080,
  scene: null,
};

beforeEach(() => {
  invokeMock.mockReset();
  openDashboardMock.mockReset();
});

describe("editorLoad", () => {
  it("invokes editor_load with the id and returns the EditorImage", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    await expect(editorLoad(sample.id)).resolves.toEqual(sample);
    expect(invokeMock).toHaveBeenCalledWith("editor_load", { id: sample.id });
  });
});

describe("editorSave", () => {
  it("invokes editor_save with the data URI and returns the new path", async () => {
    invokeMock.mockResolvedValueOnce("/tmp/captures/clippity-2.png");
    const next = await editorSave("data:image/png;base64,zzz");
    expect(invokeMock).toHaveBeenCalledWith("editor_save", {
      dataUri: "data:image/png;base64,zzz",
    });
    expect(next).toBe("/tmp/captures/clippity-2.png");
  });
});

describe("editorSaveScene", () => {
  it("invokes editor_save_scene with the id + scene JSON and returns the sidecar path", async () => {
    invokeMock.mockResolvedValueOnce(
      "/tmp/captures/.scenes/clippity-1.png.json"
    );
    const json = '{"version":1,"docName":"X","rootIds":[],"nodes":{}}';
    const path = await editorSaveScene(sample.id, json);
    expect(invokeMock).toHaveBeenCalledWith("editor_save_scene", {
      id: sample.id,
      scene: json,
    });
    expect(path).toBe("/tmp/captures/.scenes/clippity-1.png.json");
  });
});

describe("openInEditor", () => {
  it("delegates to openDashboard with view=editor and the supplied id", async () => {
    openDashboardMock.mockResolvedValue(undefined);
    await openInEditor("/tmp/captures/clippity-1.png");
    expect(openDashboardMock).toHaveBeenCalledWith(
      "editor",
      "/tmp/captures/clippity-1.png"
    );
  });
});
