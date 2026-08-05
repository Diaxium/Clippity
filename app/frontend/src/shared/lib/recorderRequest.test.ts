import { describe, expect, it } from "vitest";

import type { RecordingSettings } from "@services/tauri/clients/settings";

import {
  buildRecorderRequest,
  overlayRecorderRequest,
} from "./recorderRequest";

function settings(patch: Partial<RecordingSettings> = {}): RecordingSettings {
  return {
    microphone: true,
    systemAudio: true,
    microphoneDevice: "mic-1",
    systemDevice: "out-1",
    microphoneGainPct: 130,
    systemGainPct: 70,
    videoFps: 60,
    gifFps: 12,
    maxHeight: 1080,
    encoding: { quality: "high", keyframeSeconds: 4 },
    sources: [
      {
        kind: "webcam",
        rect: { x: 0.7, y: 0.7, w: 0.25, h: 0.25 },
      },
    ],
    cursor: true,
    outline: true,
    clipboard: false,
    ...patch,
  };
}

describe("buildRecorderRequest", () => {
  it("seeds a video recording from the persisted defaults", () => {
    const req = buildRecorderRequest("fullscreen", "mp4", settings());
    expect(req.target).toBe("fullscreen");
    expect(req.fps).toBe(60);
    expect(req.audio?.microphone).toBe(true);
    expect(req.audio?.system).toBe(true);
    expect(req.audio?.microphoneDevice).toBe("mic-1");
    expect(req.toggles?.cursor).toBe(true);
  });

  it("carries the target through unchanged", () => {
    // The Record screen picks a target; the launcher always says
    // fullscreen. Both go through here.
    expect(buildRecorderRequest("region", "mp4", settings()).target).toBe(
      "region"
    );
    expect(buildRecorderRequest("window", "mp4", settings()).target).toBe(
      "window"
    );
  });

  it("uses the GIF rate for a GIF, not the video one", () => {
    // The ranges genuinely differ — GIF's delay is stored in
    // centiseconds, so a 60 there plays back at the wrong speed.
    expect(buildRecorderRequest("fullscreen", "gif", settings()).fps).toBe(12);
  });

  it("carries the resolution cap on both formats", () => {
    // Unlike audio, the cap is meaningful for a GIF too — the backend
    // applies GIF's own pixel budget on top, tighter one winning.
    expect(
      buildRecorderRequest("fullscreen", "mp4", settings()).maxHeight
    ).toBe(1080);
    expect(
      buildRecorderRequest("fullscreen", "gif", settings()).maxHeight
    ).toBe(1080);
    expect(
      buildRecorderRequest("fullscreen", "mp4", settings({ maxHeight: 0 }))
        .maxHeight
    ).toBe(0);
  });

  it("carries the encoder settings through on both formats", () => {
    // Sent for GIF too, and ignored there. Unlike audio, there is no
    // indicator to mislead — and clearing it would lose the choice the
    // moment the user switches format back.
    for (const format of ["mp4", "gif"] as const) {
      const req = buildRecorderRequest("fullscreen", format, settings());
      expect(req.encoding?.quality, format).toBe("high");
      expect(req.encoding?.keyframeSeconds, format).toBe(4);
    }
  });

  it("never asks for audio on a GIF", () => {
    // GIF has no audio track. Sending the selection anyway would make
    // the HUD show a microphone indicator for a track nobody records.
    const req = buildRecorderRequest("fullscreen", "gif", settings());
    expect(req.audio?.microphone).toBe(false);
    expect(req.audio?.system).toBe(false);
  });

  it("records with backend defaults before settings hydrate", () => {
    // An early hotkey should still record rather than doing nothing.
    expect(buildRecorderRequest("fullscreen", "mp4", undefined)).toEqual({
      target: "fullscreen",
      format: "mp4",
    });
  });

  it("passes null for an unpinned device rather than omitting it", () => {
    const req = buildRecorderRequest(
      "fullscreen",
      "mp4",
      settings({ microphoneDevice: null, systemDevice: null })
    );
    expect(req.audio?.microphoneDevice).toBeNull();
    expect(req.audio?.systemDevice).toBeNull();
  });

  it("does not open the editor on a finished recording", () => {
    // The editor cannot load a video; `preview` must stay off however
    // the still-capture default is set.
    expect(
      buildRecorderRequest("fullscreen", "mp4", settings()).toggles?.preview
    ).toBe(false);
  });

  it("carries the clipboard preference through to the request", () => {
    // Every entry point builds through here, so this is what makes the
    // setting apply to a launcher recording and an overlay one alike.
    expect(
      buildRecorderRequest("fullscreen", "mp4", settings({ clipboard: true }))
        .toggles?.clipboard
    ).toBe(true);
    expect(
      buildRecorderRequest("region", "gif", settings({ clipboard: false }))
        .toggles?.clipboard
    ).toBe(false);
  });

  it("gives both entry points the same request for the same settings", () => {
    // The whole reason this lives in `shared/`: a recording started
    // from the launcher and one started from the Record screen must
    // resolve identically, or the same settings would mean different
    // things depending on which button was pressed.
    const s = settings();
    expect(buildRecorderRequest("fullscreen", "mp4", s)).toEqual(
      buildRecorderRequest("fullscreen", "mp4", s)
    );
  });
});

describe("overlayRecorderRequest", () => {
  const rect = { x: 10, y: 20, width: 640, height: 480 };

  it("builds from live settings when no preset opened the overlay", () => {
    const req = overlayRecorderRequest("region", "mp4", settings(), null, rect);
    expect(req.fps).toBe(60);
    expect(req.region).toEqual(rect);
  });

  it("uses a mirrored preset's request, with the drawn rectangle", () => {
    // The bug this prevents: the overlay is a separate window, so
    // without the mirror it would rebuild from live settings and
    // silently discard everything the preset specified.
    const preset = buildRecorderRequest("region", "gif", settings());
    const req = overlayRecorderRequest(
      "region",
      "mp4",
      settings({ videoFps: 10, maxHeight: 0 }),
      { ...preset, fps: 24, maxHeight: 720 },
      rect
    );
    expect(req.fps).toBe(24);
    expect(req.maxHeight).toBe(720);
    expect(req.region).toEqual(rect);
  });

  it("takes the format from the preset, not from the mirror", () => {
    // Two sources for one answer is one too many; the preset is the
    // authority on what it is.
    const preset = buildRecorderRequest("region", "gif", settings());
    const req = overlayRecorderRequest(
      "region",
      "mp4",
      settings(),
      preset,
      rect
    );
    expect(req.format).toBe("gif");
  });

  it("a null override means no preset settings survive into it", () => {
    // The leak guard: an overlay that kept the last preset's request
    // would quietly apply it to the next ordinary region recording.
    const preset = buildRecorderRequest("region", "gif", settings());
    const withPreset = overlayRecorderRequest(
      "region",
      "mp4",
      settings(),
      preset,
      rect
    );
    const without = overlayRecorderRequest(
      "region",
      "mp4",
      settings(),
      null,
      rect
    );
    expect(withPreset.format).toBe("gif");
    expect(without.format).toBe("mp4");
  });
});
