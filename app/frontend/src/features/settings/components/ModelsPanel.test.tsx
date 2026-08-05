import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modelsDownloadMock = vi.fn();
const modelsCancelMock = vi.fn();
const modelsRemoveMock = vi.fn();
const modelsUpdateMock = vi.fn();
// Both useModels and useReleaseChecks subscribe to models/changed, so the
// mock fans an emit out to every live handler rather than keeping just one.
let changedHandlers: ((m: ModelInfo[]) => void)[] = [];
const emitChanged = (m: ModelInfo[]) => changedHandlers.forEach((h) => h(m));
let releaseChecks: ReleaseCheck[] = [];
let listed: ModelInfo[] = [];

vi.mock("@services/tauri/clients/models", () => ({
  modelsList: () => Promise.resolve(listed),
  modelsDownload: (...a: unknown[]) => modelsDownloadMock(...a),
  modelsCancelDownload: (...a: unknown[]) => modelsCancelMock(...a),
  modelsRemove: (...a: unknown[]) => modelsRemoveMock(...a),
  modelsUpdate: (...a: unknown[]) => modelsUpdateMock(...a),
  modelsCheckUpdates: () => Promise.resolve(releaseChecks),
  onModelsChanged: (h: (m: ModelInfo[]) => void) => {
    changedHandlers.push(h);
    return () => {
      changedHandlers = changedHandlers.filter((x) => x !== h);
    };
  },
  onModelsProgress: () => () => {},
}));

import type { ModelInfo, ReleaseCheck } from "@services/tauri/clients/models";
import type { ModelsSettings } from "../types";
import { ModelsPanel } from "./ModelsPanel";

const seed: ModelInfo[] = [
  {
    id: "ui-elements",
    label: "UI Elements (OmniParser)",
    description: "Finds buttons and icons.",
    task: "object-detection",
    version: "1",
    checkable: false,
    sizeBytes: 12_136_163,
    hint: "12 MB · UI-focused · recommended",
    phase: "not-installed",
  },
  {
    id: "yolov10n",
    label: "General Objects — Fast",
    description: "80 everyday classes.",
    task: "object-detection",
    version: "1",
    checkable: false,
    sizeBytes: 9_386_116,
    hint: "9 MB · fastest",
    phase: "installed",
  },
];

const checkable: ModelInfo = {
  id: "checkable-model",
  label: "Checkable Model",
  description: "A release-backed detector with live update checks.",
  task: "object-detection",
  version: "2",
  installedVersion: "rel-v2",
  checkable: true,
  sizeBytes: 44_810_302,
  hint: "45 MB · release-backed",
  phase: "installed",
};

const settings: ModelsSettings = {
  autoDownload: true,
  objectModel: "ui-elements",
  confidence: 25,
};

beforeEach(() => {
  modelsDownloadMock.mockReset().mockResolvedValue(undefined);
  modelsCancelMock.mockReset().mockResolvedValue(undefined);
  modelsRemoveMock.mockReset().mockResolvedValue(undefined);
  modelsUpdateMock.mockReset().mockResolvedValue(undefined);
  changedHandlers = [];
  releaseChecks = [];
  listed = seed;
});

describe("ModelsPanel", () => {
  it("hydrates the model list and shows per-status actions", async () => {
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    // not-installed model → a Download action with its size.
    expect(
      screen.getByRole("button", { name: /Download \(11\.6 MB\)/ })
    ).toBeInTheDocument();
    // installed model → an Installed badge + Remove action.
    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("invokes modelsDownload when Download is clicked", async () => {
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    await act(async () => {
      screen.getByRole("button", { name: /Download/ }).click();
    });
    expect(modelsDownloadMock).toHaveBeenCalledWith("ui-elements");
  });

  it("renders a progress bar when a model is downloading (via changed event)", async () => {
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    await act(async () => {
      emitChanged([
        {
          ...seed[0]!,
          phase: "downloading",
          downloaded: 6_068_081,
          total: 12_136_163,
        },
        seed[1]!,
      ]);
    });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows an Update action for an outdated model and re-downloads on click", async () => {
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    await act(async () => {
      emitChanged([
        { ...seed[0]!, phase: "update-available", version: "2" },
        seed[1]!,
      ]);
    });
    const update = screen.getByRole("button", { name: /Update to v2/ });
    expect(update).toBeInTheDocument();
    expect(screen.getByText("Update available")).toBeInTheDocument();
    await act(async () => {
      update.click();
    });
    // Update reuses the download command — it swaps changed artifacts in place.
    expect(modelsDownloadMock).toHaveBeenCalledWith("ui-elements");
  });

  it("self-updates to the latest release when the live check reports one", async () => {
    // Installed at rel-v2, but the live check says rel-v3 is out.
    listed = [checkable];
    releaseChecks = [
      {
        id: "checkable-model",
        latestTag: "rel-v3",
        publishedAt: "2026-06-19T00:00:00Z",
        htmlUrl: "https://github.com/example/model/releases/tag/rel-v3",
        installed: true,
        installedIsLatest: false,
        updatable: true,
      },
    ];
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    // Shows which version is installed and that a newer one is published.
    expect(screen.getByText("rel-v2")).toBeInTheDocument();
    expect(
      screen.getByText(/newer release rel-v3 available/)
    ).toBeInTheDocument();
    // The Update button fetches the live release (not the pinned registry).
    const update = screen.getByRole("button", { name: /Update to rel-v3/ });
    await act(async () => {
      update.click();
    });
    expect(modelsUpdateMock).toHaveBeenCalledWith("checkable-model");
    expect(modelsDownloadMock).not.toHaveBeenCalled();
  });

  it("offers to install the latest release for a not-installed model", async () => {
    listed = [
      { ...checkable, phase: "not-installed", installedVersion: undefined },
    ];
    releaseChecks = [
      {
        id: "checkable-model",
        latestTag: "rel-v3",
        publishedAt: "2026-06-21T00:00:00Z",
        htmlUrl: "https://github.com/example/model/releases/tag/rel-v3",
        installed: false,
        installedIsLatest: false,
        updatable: true,
      },
    ];
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    expect(screen.getByText(/latest release: rel-v3/)).toBeInTheDocument();
    const download = screen.getByRole("button", {
      name: /Download rel-v3/,
    });
    await act(async () => {
      download.click();
    });
    // Installs the live release, not the pinned registry build.
    expect(modelsUpdateMock).toHaveBeenCalledWith("checkable-model");
    expect(modelsDownloadMock).not.toHaveBeenCalled();
  });

  it("reports an installed model as the latest published release", async () => {
    listed = [checkable];
    releaseChecks = [
      {
        id: "checkable-model",
        latestTag: "rel-v2",
        publishedAt: "2026-06-01T00:00:00Z",
        htmlUrl: "https://github.com/example/model/releases/tag/rel-v2",
        installed: true,
        installedIsLatest: true,
        updatable: true,
      },
    ];
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={() => {}} />);
    });
    expect(screen.getByText("latest published release")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Update to/ })
    ).not.toBeInTheDocument();
  });

  it("patches the selected object model when a detector is picked", async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(<ModelsPanel value={settings} onChange={onChange} />);
    });
    await act(async () => {
      screen.getByRole("button", { name: /General Objects — Fast/ }).click();
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectModel: "yolov10n" })
    );
  });
});
