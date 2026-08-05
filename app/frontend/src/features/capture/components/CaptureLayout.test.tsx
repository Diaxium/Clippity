import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDashboard: vi.fn().mockResolvedValue(undefined),
  captureTrigger: vi.fn().mockResolvedValue(null),
  recordTrigger: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("@features/library", () => ({
  LibraryLayout: () => <div data-testid="capture-history">History panel</div>,
}));

vi.mock("@features/presets", () => ({
  PresetsLayout: () => <div data-testid="capture-presets">Presets panel</div>,
}));

vi.mock("@features/settings", () => ({
  useSettings: () => null,
  useSettingsPatch: () => vi.fn(),
  useSettingsStore: () => null,
}));

vi.mock("@services/tauri/clients/dashboard", () => ({
  openDashboard: (...args: unknown[]) => mocks.openDashboard(...args),
}));

vi.mock("../hooks/useCaptureDefaults", () => ({
  useCaptureDefaults: vi.fn(),
}));

vi.mock("../hooks/useCaptureWorkflow", () => ({
  useCaptureWorkflow: () => ({ trigger: mocks.captureTrigger }),
}));

vi.mock("../hooks/useRecordWorkflow", () => ({
  useRecordWorkflow: () => ({ trigger: mocks.recordTrigger }),
}));

vi.mock("./CaptureTypeGrid", () => ({
  CaptureTypeGrid: () => <div>Capture type grid</div>,
}));

vi.mock("./CustomModesPanel", () => ({
  CustomModesPanel: () => <div>Custom modes</div>,
}));

vi.mock("./CaptureOptionsPanel", () => ({
  CaptureOptionsPanel: () => <div>Capture options</div>,
}));

vi.mock("./OutputControls", () => ({
  OutputControls: () => <div>Output controls</div>,
}));

vi.mock("./CompactCaptureRow", () => ({
  CompactCaptureRow: () => <div>Compact capture</div>,
}));

vi.mock("./RecordTypeGrid", () => ({
  RecordTypeGrid: () => <div>Record type grid</div>,
  RecordFormatGrid: () => <div>Record format grid</div>,
}));

vi.mock("./RecordOptionsPanel", () => ({
  RecordOptionsPanel: () => <div>Record options</div>,
}));

vi.mock("./CaptureFooter", () => ({
  CaptureFooter: () => <div>Capture footer</div>,
}));

vi.mock("./RecordFooter", () => ({
  RecordFooter: () => <div>Record footer</div>,
}));

import { useCaptureStore } from "../state/captureStore";
import { CaptureLayout } from "./CaptureLayout";

const initialState = useCaptureStore.getState();

describe("CaptureLayout", () => {
  beforeEach(() => {
    useCaptureStore.setState(initialState, true);
    mocks.openDashboard.mockClear();
  });

  it("opens History inside the capture window", () => {
    render(<CaptureLayout />);

    fireEvent.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getByTestId("capture-history")).toBeInTheDocument();
    expect(mocks.openDashboard).not.toHaveBeenCalled();
  });

  it("opens Presets inside the capture window", () => {
    render(<CaptureLayout />);

    fireEvent.click(screen.getByRole("button", { name: "Presets" }));

    expect(screen.getByTestId("capture-presets")).toBeInTheDocument();
    expect(mocks.openDashboard).not.toHaveBeenCalled();
  });
});
