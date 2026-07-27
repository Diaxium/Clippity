import { beforeEach, describe, expect, it } from "vitest";

import { buildRequest, useCaptureStore } from "./captureStore";

const initialState = useCaptureStore.getState();

describe("useCaptureStore", () => {
  beforeEach(() => {
    useCaptureStore.setState(initialState, true);
  });

  it("defaults to region + the legacy default toggles", () => {
    const s = useCaptureStore.getState();
    expect(s.captureType).toBe("region");
    expect(s.customMode).toBeNull();
    expect(s.preview).toBe(true);
    expect(s.clipboard).toBe(false);
    expect(s.cursor).toBe(false);
    expect(s.delayEnabled).toBe(false);
    expect(s.delaySeconds).toBe(5);
    expect(s.effect).toBe("none");
    expect(s.share).toBe("none");
    expect(s.nav).toBe("capture");
  });

  it("setCaptureType to non-custom clears customMode", () => {
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("palette-capture");
    expect(useCaptureStore.getState().customMode).toBe("palette-capture");

    useCaptureStore.getState().setCaptureType("fullscreen");
    expect(useCaptureStore.getState().customMode).toBeNull();
  });

  it("setCaptureType back to custom preserves the previous sub-mode", () => {
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("freehand");
    useCaptureStore.getState().setCaptureType("custom");
    expect(useCaptureStore.getState().customMode).toBe("freehand");
  });

  it("setOption mutates the right toggle", () => {
    useCaptureStore.getState().setOption("clipboard", true);
    expect(useCaptureStore.getState().clipboard).toBe(true);
    expect(useCaptureStore.getState().preview).toBe(true);
    expect(useCaptureStore.getState().cursor).toBe(false);
  });

  it("setDelaySeconds clamps to 1..60", () => {
    useCaptureStore.getState().setDelaySeconds(0);
    expect(useCaptureStore.getState().delaySeconds).toBe(1);
    useCaptureStore.getState().setDelaySeconds(99);
    expect(useCaptureStore.getState().delaySeconds).toBe(60);
    useCaptureStore.getState().setDelaySeconds(12);
    expect(useCaptureStore.getState().delaySeconds).toBe(12);
  });

  it("hydrateDefaults seeds the session toggles from persisted defaults", () => {
    useCaptureStore.getState().hydrateDefaults({
      preview: false,
      clipboard: true,
      cursor: true,
      enhance: true,
      delay: true,
      delaySeconds: 9,
      scrollDirection: "up",
      paletteCount: 8,
    });
    const s = useCaptureStore.getState();
    expect(s.defaultsHydrated).toBe(true);
    expect(s.preview).toBe(false);
    expect(s.clipboard).toBe(true);
    expect(s.cursor).toBe(true);
    expect(s.enhance).toBe(true);
    expect(s.delayEnabled).toBe(true);
    expect(s.delaySeconds).toBe(9);
    expect(s.scrollDirection).toBe("up");
  });

  it("hydrateDefaults clamps the seeded delay into 1..60", () => {
    useCaptureStore.getState().hydrateDefaults({
      preview: true,
      clipboard: false,
      cursor: false,
      enhance: false,
      delay: true,
      delaySeconds: 250,
      scrollDirection: "down",
      paletteCount: 6,
    });
    expect(useCaptureStore.getState().delaySeconds).toBe(60);
  });

  it("hydrateDefaults is a one-shot — later calls never clobber session edits", () => {
    useCaptureStore.getState().hydrateDefaults({
      preview: true,
      clipboard: false,
      cursor: false,
      enhance: false,
      delay: false,
      delaySeconds: 5,
      scrollDirection: "down",
      paletteCount: 6,
    });
    // User tweaks a toggle mid-session…
    useCaptureStore.getState().setOption("clipboard", true);
    // …and a later settings change re-fires hydrateDefaults. It must
    // no-op so the in-session choice survives.
    useCaptureStore.getState().hydrateDefaults({
      preview: false,
      clipboard: false,
      cursor: false,
      enhance: false,
      delay: false,
      delaySeconds: 5,
      scrollDirection: "down",
      paletteCount: 6,
    });
    const s = useCaptureStore.getState();
    expect(s.clipboard).toBe(true);
    expect(s.preview).toBe(true);
  });
});

describe("buildRequest", () => {
  beforeEach(() => {
    useCaptureStore.setState(initialState, true);
  });

  it("emits a region request from defaults", () => {
    const req = buildRequest(useCaptureStore.getState());
    expect(req).toEqual({
      type: "region",
      customMode: null,
      toggles: {
        preview: true,
        clipboard: false,
        cursor: false,
        enhance: false,
      },
      delay: null,
      effect: null,
      share: null,
    });
  });

  it("includes delay as an object when enabled", () => {
    useCaptureStore.getState().setDelayEnabled(true);
    useCaptureStore.getState().setDelaySeconds(8);
    const req = buildRequest(useCaptureStore.getState());
    expect(req.delay).toEqual({ seconds: 8 });
  });

  it("zeros customMode unless type is custom", () => {
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("multi-area");
    expect(buildRequest(useCaptureStore.getState()).customMode).toBe(
      "multi-area"
    );

    useCaptureStore.getState().setCaptureType("fullscreen");
    expect(buildRequest(useCaptureStore.getState()).customMode).toBeNull();
  });

  it('maps "none" effect/share to null', () => {
    useCaptureStore.getState().setEffect("none");
    useCaptureStore.getState().setShare("none");
    const r1 = buildRequest(useCaptureStore.getState());
    expect(r1.effect).toBeNull();
    expect(r1.share).toBeNull();

    useCaptureStore.getState().setEffect("blur");
    useCaptureStore.getState().setShare("clipboard");
    const r2 = buildRequest(useCaptureStore.getState());
    expect(r2.effect).toBe("blur");
    expect(r2.share).toBe("clipboard");
  });
});
