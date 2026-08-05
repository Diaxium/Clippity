import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `useSettingsPatch` mutates the store optimistically and *then* fires
// the IPC, so stubbing only the IPC leaves the real patch path — which
// is what makes "toggle the mic, the level slider appears" a test of the
// panel rather than of a mock.
vi.mock("@services/tauri/clients/settings", () => ({
  updateSettings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: vi.fn(),
}));

import { useSettingsStore } from "@features/settings";

import { useCaptureStore } from "../state/captureStore";
import { RecordOptionsPanel } from "./RecordOptionsPanel";
import type { Settings } from "@features/settings/types";

type Recording = Settings["recording"];

function recording(patch: Partial<Recording> = {}): Recording {
  return {
    microphone: false,
    systemAudio: false,
    microphoneDevice: null,
    systemDevice: null,
    microphoneGainPct: 100,
    systemGainPct: 100,
    videoFps: 30,
    gifFps: 15,
    maxHeight: 0,
    encoding: {},
    sources: [],
    cursor: false,
    outline: true,
    clipboard: false,
    ...patch,
  };
}

/** Only `settings.recording` is read by this panel; the rest of the
 *  Settings shape is irrelevant to it and is stubbed rather than
 *  duplicated, so this test doesn't break every time an unrelated
 *  settings section gains a field. */
function hydrate(next: Recording) {
  useSettingsStore.setState({
    settings: { recording: next } as unknown as Settings,
  });
}

function panel() {
  return render(<RecordOptionsPanel onOpenSettings={() => {}} />);
}

describe("RecordOptionsPanel", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null });
    useCaptureStore.setState({ recordFormat: "mp4" });
  });

  it("disables every control until settings hydrate", () => {
    // An early Record screen must not let the user set something that
    // silently goes nowhere.
    panel();
    expect(
      screen.getByRole("switch", { name: /record cursor/i })
    ).toBeDisabled();
  });

  // ---------- audio levels ----------

  it("shows a level slider only once its input is on", () => {
    hydrate(recording());
    panel();
    expect(
      screen.queryByLabelText(/record microphone level/i)
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: /record microphone/i }));
    expect(
      screen.getByLabelText(/record microphone level/i)
    ).toBeInTheDocument();
    // The other input is still off, so its slider stays away.
    expect(
      screen.queryByLabelText(/record system audio level/i)
    ).not.toBeInTheDocument();
  });

  it("writes each input's level to its own setting", () => {
    hydrate(recording({ microphone: true, systemAudio: true }));
    panel();

    fireEvent.change(screen.getByLabelText(/record microphone level/i), {
      target: { value: "150" },
    });
    expect(
      useSettingsStore.getState().settings?.recording.microphoneGainPct
    ).toBe(150);
    expect(useSettingsStore.getState().settings?.recording.systemGainPct).toBe(
      100
    );
  });

  // ---------- quality ----------

  it("offers a quality step for video and hides it for GIF", () => {
    hydrate(recording());
    const { rerender } = panel();
    expect(
      screen.getByRole("button", { name: /video quality/i })
    ).toBeInTheDocument();

    useCaptureStore.setState({ recordFormat: "gif" });
    rerender(<RecordOptionsPanel onOpenSettings={() => {}} />);
    expect(
      screen.queryByRole("button", { name: /video quality/i })
    ).not.toBeInTheDocument();
  });

  it("keeps the rest of the encoding when quality changes", () => {
    // The row edits one field of a nested struct; clobbering the
    // siblings would silently reset a bitrate the user had set.
    hydrate(recording({ encoding: { keyframeSeconds: 5 } }));
    panel();
    fireEvent.click(screen.getByRole("button", { name: /video quality/i }));
    fireEvent.click(screen.getByRole("option", { name: /high/i }));

    const encoding = useSettingsStore.getState().settings?.recording.encoding;
    expect(encoding?.quality).toBe("high");
    expect(encoding?.keyframeSeconds).toBe(5);
  });

  // ---------- sources ----------

  it("summarises sources and cannot be switched on when there are none", () => {
    hydrate(recording());
    panel();
    expect(screen.getByText(/nothing over the recording/i)).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /draw sources over the recording/i })
    ).toBeDisabled();
    // The way in is the shortcut, not the switch.
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });

  it("switches every source off together and back on again", () => {
    hydrate(
      recording({
        sources: [
          { kind: "webcam", rect: { x: 0.72, y: 0.71, w: 0.25, h: 0.25 } },
          {
            kind: "image",
            path: "a.png",
            rect: { x: 0.03, y: 0.04, w: 0.2, h: 0.2 },
          },
        ],
      })
    );
    panel();
    expect(
      screen.getByText(/camera bottom right \+1 more/i)
    ).toBeInTheDocument();

    const master = screen.getByRole("switch", {
      name: /draw sources over the recording/i,
    });
    fireEvent.click(master);
    let stored = useSettingsStore.getState().settings?.recording.sources ?? [];
    expect(stored.every((s) => s.enabled === false)).toBe(true);

    fireEvent.click(master);
    stored = useSettingsStore.getState().settings?.recording.sources ?? [];
    expect(stored.every((s) => s.enabled === true)).toBe(true);
  });

  it("keeps the sources row on a GIF", () => {
    // A GIF is still a picture of the screen.
    useCaptureStore.setState({ recordFormat: "gif" });
    hydrate(recording());
    panel();
    expect(
      screen.getByRole("switch", { name: /draw sources over the recording/i })
    ).toBeInTheDocument();
  });
});
