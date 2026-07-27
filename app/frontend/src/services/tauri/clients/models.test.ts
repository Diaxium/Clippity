import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    modelsChanged: "clippity://models/changed",
    modelsProgress: "clippity://models/progress",
  },
}));

import {
  ensureObjectModel,
  modelsCancelDownload,
  modelsCheckUpdates,
  modelsDownload,
  modelsList,
  modelsRemove,
  modelsUpdate,
  onModelsChanged,
  onModelsProgress,
  type ModelInfo,
  type ObjectModelReadiness,
  type ReleaseCheck,
} from "./models";

const installed: ModelInfo = {
  id: "ui-elements",
  label: "UI Elements (OmniParser)",
  description: "Finds buttons and icons.",
  task: "object-detection",
  version: "1",
  checkable: false,
  sizeBytes: 12_136_163,
  hint: "12 MB · UI-focused · recommended",
  phase: "installed",
};

const downloading: ModelInfo = {
  ...installed,
  id: "yolov10n",
  phase: "downloading",
  downloaded: 1024,
  total: 9_386_116,
};

beforeEach(() => {
  invokeMock.mockReset();
  onMock.mockReset();
});

describe("modelsList", () => {
  it("invokes models_list with no args", async () => {
    invokeMock.mockResolvedValueOnce([installed, downloading]);
    const out = await modelsList();
    expect(invokeMock).toHaveBeenCalledWith("models_list");
    expect(out).toHaveLength(2);
    expect(out[0]!.phase).toBe("installed");
  });
});

describe("download / cancel / remove", () => {
  it("wraps the id for models_download", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await modelsDownload("yolov10n");
    expect(invokeMock).toHaveBeenCalledWith("models_download", {
      id: "yolov10n",
    });
  });

  it("wraps the id for models_cancel_download", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await modelsCancelDownload("yolov10n");
    expect(invokeMock).toHaveBeenCalledWith("models_cancel_download", {
      id: "yolov10n",
    });
  });

  it("wraps the id for models_remove", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await modelsRemove("ui-elements");
    expect(invokeMock).toHaveBeenCalledWith("models_remove", {
      id: "ui-elements",
    });
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("disk full");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(modelsDownload("yolov10n")).rejects.toBe(boom);
  });

  it("wraps the id for models_update", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await modelsUpdate("ui-elements");
    expect(invokeMock).toHaveBeenCalledWith("models_update", {
      id: "ui-elements",
    });
  });
});

describe("modelsCheckUpdates", () => {
  it("invokes models_check_updates and returns the verdicts", async () => {
    const checks: ReleaseCheck[] = [
      {
        id: "ui-elements",
        latestTag: "rel-v3",
        publishedAt: "2026-06-19T00:00:00Z",
        htmlUrl: "https://github.com/example/model/releases/tag/rel-v3",
        installed: true,
        installedIsLatest: false,
        updatable: true,
      },
    ];
    invokeMock.mockResolvedValueOnce(checks);
    const out = await modelsCheckUpdates();
    expect(invokeMock).toHaveBeenCalledWith("models_check_updates");
    expect(out[0]!.latestTag).toBe("rel-v3");
    expect(out[0]!.installedIsLatest).toBe(false);
  });
});

describe("ensureObjectModel", () => {
  it("invokes ensure_object_model and returns the verdict", async () => {
    const verdict: ObjectModelReadiness = {
      status: "downloading",
      model: downloading,
    };
    invokeMock.mockResolvedValueOnce(verdict);
    const out = await ensureObjectModel();
    expect(invokeMock).toHaveBeenCalledWith("ensure_object_model");
    expect(out.status).toBe("downloading");
    expect(out.model.id).toBe("yolov10n");
  });
});

describe("event wrappers", () => {
  it("onModelsChanged subscribes to the changed event and forwards the list", () => {
    onMock.mockReturnValueOnce(() => {});
    const handler = vi.fn();
    onModelsChanged(handler);
    const [eventName, fn] = onMock.mock.calls[0]!;
    expect(eventName).toBe("clippity://models/changed");
    fn([installed]);
    expect(handler).toHaveBeenCalledWith([installed]);
  });

  it("onModelsProgress subscribes to the progress event", () => {
    const unsub = vi.fn();
    onMock.mockReturnValueOnce(unsub);
    const returned = onModelsProgress(() => {});
    expect(onMock.mock.calls[0]![0]).toBe("clippity://models/progress");
    returned();
    expect(unsub).toHaveBeenCalled();
  });
});
