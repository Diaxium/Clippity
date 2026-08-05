import { describe, expect, it } from "vitest";

import { WINDOW_BACKDROP_OPTIONS } from "../constants";
import type { WindowBackdrop } from "../types";
import {
  BACKDROP_ACCEPTS_TINT,
  BACKDROP_SAMPLES_LIVE_CONTENT,
  DEFAULT_BACKDROP_TUNING,
  DEFAULT_BACKDROP_TUNING_SET,
  DEFAULT_UNTINTED_BACKDROP_TUNING,
  backdropTuningControls,
  defaultBackdropTuning,
  resolveBackdropTuning,
  withBackdropTuning,
} from "./backdrop";

const ALL: WindowBackdrop[] = WINDOW_BACKDROP_OPTIONS.map((o) => o.value);

describe("backdrop tuning tables", () => {
  it("covers every offered material", () => {
    // A material added to the picker without an entry here would fall
    // through to the tintable default and quietly show a slider Windows
    // ignores.
    for (const backdrop of ALL) {
      expect(BACKDROP_ACCEPTS_TINT).toHaveProperty(backdrop);
      expect(BACKDROP_SAMPLES_LIVE_CONTENT).toHaveProperty(backdrop);
      expect(DEFAULT_BACKDROP_TUNING_SET).toHaveProperty(backdrop);
    }
  });

  it("ships every scale knob neutral so nothing changes until a slider moves", () => {
    for (const backdrop of ALL) {
      const tuning = defaultBackdropTuning(backdrop);
      expect(tuning.glassStrength).toBe(100);
      expect(tuning.blurStrength).toBe(100);
      expect(tuning.saturation).toBe(100);
    }
  });

  it("ships each material the tint it rendered with before tuning existed", () => {
    // Acrylic's tint was hardcoded to alpha 178 ≈ 70 %; Blur's to alpha
    // 1 (visually none); the rest never read one at all.
    expect(defaultBackdropTuning("acrylic").tintStrength).toBe(70);
    for (const backdrop of ALL.filter((b) => b !== "acrylic")) {
      expect(defaultBackdropTuning(backdrop).tintStrength).toBe(0);
    }
  });

  it("never ships a tint to a material that ignores it", () => {
    for (const backdrop of ALL.filter((b) => !BACKDROP_ACCEPTS_TINT[b])) {
      expect(defaultBackdropTuning(backdrop).tintStrength).toBe(0);
    }
  });

  it("marks only the wallpaper-derived materials as not sampling live content", () => {
    expect(BACKDROP_SAMPLES_LIVE_CONTENT.mica).toBe(false);
    expect(BACKDROP_SAMPLES_LIVE_CONTENT.tabbed).toBe(false);
    expect(BACKDROP_SAMPLES_LIVE_CONTENT.acrylic).toBe(true);
    expect(BACKDROP_SAMPLES_LIVE_CONTENT.blur).toBe(true);
    expect(BACKDROP_SAMPLES_LIVE_CONTENT.clear).toBe(true);
  });
});

describe("backdropTuningControls", () => {
  it("offers the tint row only where Windows reads it", () => {
    const keys = (backdrop: WindowBackdrop) =>
      backdropTuningControls(backdrop).map((c) => c.key);
    expect(keys("acrylic")).toContain("tintStrength");
    expect(keys("blur")).toContain("tintStrength");
    expect(keys("mica")).not.toContain("tintStrength");
    expect(keys("tabbed")).not.toContain("tintStrength");
    expect(keys("clear")).not.toContain("tintStrength");
  });

  it("always offers the three CSS-side knobs", () => {
    for (const backdrop of ALL) {
      const keys = backdropTuningControls(backdrop).map((c) => c.key);
      expect(keys).toEqual(
        expect.arrayContaining(["glassStrength", "blurStrength", "saturation"])
      );
    }
  });

  it("writes each row to a real BackdropTuning field", () => {
    for (const control of backdropTuningControls("acrylic")) {
      expect(DEFAULT_BACKDROP_TUNING).toHaveProperty(control.key);
      expect(control.min).toBeLessThan(control.max);
    }
  });
});

describe("resolveBackdropTuning", () => {
  it("falls back to the material's shipped tuning before settings hydrate", () => {
    expect(resolveBackdropTuning(undefined, "acrylic")).toEqual(
      DEFAULT_BACKDROP_TUNING
    );
    expect(resolveBackdropTuning(undefined, "clear")).toEqual(
      DEFAULT_UNTINTED_BACKDROP_TUNING
    );
  });

  it("fills knobs missing from a settings file written before they existed", () => {
    const partial = {
      ...DEFAULT_BACKDROP_TUNING_SET,
      mica: { saturation: 140 },
    } as never;
    expect(resolveBackdropTuning(partial, "mica")).toEqual({
      ...DEFAULT_UNTINTED_BACKDROP_TUNING,
      saturation: 140,
    });
  });

  it("reads each material's own numbers", () => {
    const set = withBackdropTuning(DEFAULT_BACKDROP_TUNING_SET, "blur", {
      tintStrength: 20,
      glassStrength: 30,
      blurStrength: 40,
      saturation: 150,
    });
    expect(resolveBackdropTuning(set, "blur").glassStrength).toBe(30);
    expect(resolveBackdropTuning(set, "mica")).toEqual(
      DEFAULT_UNTINTED_BACKDROP_TUNING
    );
  });
});

describe("withBackdropTuning", () => {
  it("leaves the other materials untouched — the point of storing per material", () => {
    const next = withBackdropTuning(DEFAULT_BACKDROP_TUNING_SET, "acrylic", {
      ...DEFAULT_BACKDROP_TUNING,
      glassStrength: 0,
    });
    expect(next.acrylic.glassStrength).toBe(0);
    expect(next.mica).toEqual(DEFAULT_UNTINTED_BACKDROP_TUNING);
    expect(next.tabbed).toEqual(DEFAULT_UNTINTED_BACKDROP_TUNING);
    expect(next.clear).toEqual(DEFAULT_UNTINTED_BACKDROP_TUNING);
  });

  it("produces a complete set from an undefined one", () => {
    const next = withBackdropTuning(undefined, "clear", {
      ...DEFAULT_UNTINTED_BACKDROP_TUNING,
      blurStrength: 0,
    });
    for (const backdrop of ALL) expect(next).toHaveProperty(backdrop);
    expect(next.clear.blurStrength).toBe(0);
  });
});
