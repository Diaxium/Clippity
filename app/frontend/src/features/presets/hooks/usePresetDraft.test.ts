import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CapturePreset } from "@services/tauri/clients/presets";
import { isRecordingPreset } from "@services/tauri/clients/presets";
import type { CaptureRequest, RecorderRequest } from "@clippity/shared";

import {
  draftFromPreset,
  draftToInput,
  usePresetDraft,
} from "./usePresetDraft";

/** Narrow a built input to the capture shape, failing loudly otherwise —
 *  the tests below assert on capture-only fields. */
function asCapture(r: CaptureRequest | RecorderRequest): CaptureRequest {
  if (isRecordingPreset(r)) throw new Error("expected a capture request");
  return r;
}

function asRecording(r: CaptureRequest | RecorderRequest): RecorderRequest {
  if (!isRecordingPreset(r)) throw new Error("expected a recording request");
  return r;
}

describe("usePresetDraft", () => {
  it("starts empty + invalid, becomes valid once named", () => {
    const { result } = renderHook(() => usePresetDraft());
    expect(result.current.valid).toBe(false);
    act(() => result.current.set("name", "My preset"));
    expect(result.current.valid).toBe(true);
    expect(result.current.draft.name).toBe("My preset");
  });

  it("draftToInput maps toggles + output and trims the name", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => {
      result.current.set("name", "  Region grab  ");
      result.current.set("type", "region");
      result.current.set("clipboard", true);
      result.current.set("openEditor", true);
      result.current.set("saveDir", "/caps");
    });
    const input = draftToInput(result.current.draft);
    expect(input.name).toBe("Region grab");
    const request = asCapture(input.request);
    expect(request.type).toBe("region");
    expect(request.toggles.clipboard).toBe(true);
    expect(request.toggles.preview).toBe(false);
    expect(input.output).toEqual({ openEditor: true, saveDir: "/caps" });
  });

  it("draftFromPreset round-trips an existing preset", () => {
    const p: CapturePreset = {
      id: "p1",
      name: "Shot",
      request: {
        type: "window",
        customMode: null,
        toggles: {
          preview: false,
          clipboard: false,
          cursor: true,
          enhance: false,
        },
        delay: null,
        effect: null,
        share: null,
      },
      output: { openEditor: true, saveDir: null },
    };
    expect(draftFromPreset(p)).toMatchObject({
      name: "Shot",
      mode: "capture",
      type: "window",
      cursor: true,
      openEditor: true,
      saveDir: null,
    });
  });

  // ---------- recording presets ----------

  it("builds a recording request when the mode is record", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => {
      result.current.set("name", "Demo");
      result.current.set("mode", "record");
      result.current.set("type", "fullscreen");
      result.current.set("fps", 60);
      result.current.set("maxHeight", 1080);
      result.current.set("microphone", true);
    });
    const request = asRecording(draftToInput(result.current.draft).request);
    expect(request.target).toBe("fullscreen");
    expect(request.format).toBe("mp4");
    expect(request.fps).toBe(60);
    expect(request.maxHeight).toBe(1080);
    expect(request.audio?.microphone).toBe(true);
  });

  it("never saves audio on a GIF preset", () => {
    // A preset that says "microphone" and records silence is a lie on
    // disk, even though the backend would empty it at run time.
    const { result } = renderHook(() => usePresetDraft());
    act(() => {
      result.current.set("name", "Loop");
      result.current.set("mode", "record");
      result.current.set("microphone", true);
      result.current.set("systemAudio", true);
      result.current.set("format", "gif");
    });
    const request = asRecording(draftToInput(result.current.draft).request);
    expect(request.audio?.microphone).toBe(false);
    expect(request.audio?.system).toBe(false);
  });

  it("pulls the frame rate into GIF's range on a format flip", () => {
    // Otherwise the preset saves a 60 the backend silently clamps, and
    // the user sees their setting change on its own next time.
    const { result } = renderHook(() => usePresetDraft());
    act(() => {
      result.current.set("mode", "record");
      result.current.set("fps", 60);
    });
    act(() => result.current.set("format", "gif"));
    expect(result.current.draft.fps).toBe(30);
  });

  it("never asks the editor to open a recording", () => {
    // The editor cannot load a video, so `openEditor` must not survive a
    // mode flip into a recording preset.
    const { result } = renderHook(() => usePresetDraft());
    act(() => {
      result.current.set("name", "Demo");
      result.current.set("openEditor", true);
      result.current.set("mode", "record");
    });
    const input = draftToInput(result.current.draft);
    expect(input.output.openEditor).toBe(false);
    expect(asRecording(input.request).toggles?.preview).toBe(false);
  });

  it("round-trips a recording preset back into a draft", () => {
    const p: CapturePreset = {
      id: "p2",
      name: "Screen demo",
      request: {
        target: "region",
        format: "gif",
        fps: 12,
        maxHeight: 720,
        audio: { microphone: false, system: false },
        toggles: {
          cursor: true,
          clicks: false,
          preview: false,
          clipboard: true,
        },
      },
      output: { openEditor: false, saveDir: "/clips" },
    };
    expect(draftFromPreset(p)).toMatchObject({
      name: "Screen demo",
      mode: "record",
      type: "region",
      format: "gif",
      fps: 12,
      maxHeight: 720,
      cursor: true,
      clipboard: true,
      saveDir: "/clips",
    });
  });
});
