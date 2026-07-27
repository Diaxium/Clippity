import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CapturePreset } from "@services/tauri/clients/presets";

import {
  draftFromPreset,
  draftToInput,
  usePresetDraft,
} from "./usePresetDraft";

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
    expect(input.request.type).toBe("region");
    expect(input.request.toggles.clipboard).toBe(true);
    expect(input.request.toggles.preview).toBe(false);
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
      type: "window",
      cursor: true,
      openEditor: true,
      saveDir: null,
    });
  });
});
