import { describe, expect, it } from "vitest";

import {
  AVAILABLE_CUSTOM_MODES,
  AVAILABLE_TYPES,
  CAPTURE_TYPES,
  CUSTOM_MODES_ADVANCED,
  CUSTOM_MODES_STANDARD,
  DEFAULT_TOGGLES,
  isCustomModeInstalled,
  isCustomModeUsable,
  visibleOptionKeys,
} from "./modes";
import {
  UNMANAGED_PROFILE,
  type Capabilities,
} from "@services/tauri/clients/provisioning";

describe("CAPTURE_TYPES", () => {
  it("declares the four legacy capture types in order", () => {
    expect(CAPTURE_TYPES.map((m) => m.id)).toEqual([
      "region",
      "window",
      "fullscreen",
      "custom",
    ]);
  });

  it("marks all four capture types armable (post-custom-modes-port)", () => {
    expect(AVAILABLE_TYPES.has("region")).toBe(true);
    expect(AVAILABLE_TYPES.has("window")).toBe(true);
    expect(AVAILABLE_TYPES.has("fullscreen")).toBe(true);
    expect(AVAILABLE_TYPES.has("custom")).toBe(true);
    expect(AVAILABLE_TYPES.size).toBe(4);
  });

  it("attaches an unavailableHint to every disabled type", () => {
    for (const def of CAPTURE_TYPES) {
      if (!def.available) {
        expect(def.unavailableHint, `${def.id} missing hint`).toBeTruthy();
      }
    }
  });
});

describe("CUSTOM_MODES_*", () => {
  it("declares the 8-mode catalogue (Freehand now lives in the Region dropdown)", () => {
    const all = [...CUSTOM_MODES_STANDARD, ...CUSTOM_MODES_ADVANCED];
    expect(all).toHaveLength(8);
    expect(all.map((m) => m.id).sort()).toEqual(
      [
        "clipboard",
        "color-picker",
        "grab-text",
        "multi-area",
        "object",
        "palette-capture",
        "panoramic",
        "scrolling-window",
      ].sort()
    );
    // Freehand is no longer a Custom tile — it moved under the overlay's
    // Region selection-method dropdown.
    expect(all.map((m) => m.id)).not.toContain("freehand");
  });

  it("arms object / clipboard / multi-area / color-picker / palette / grab-text / scrolling / panoramic", () => {
    expect(AVAILABLE_CUSTOM_MODES.has("object")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("clipboard")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("multi-area")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("color-picker")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("palette-capture")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("grab-text")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("scrolling-window")).toBe(true);
    expect(AVAILABLE_CUSTOM_MODES.has("panoramic")).toBe(true);
    // Freehand is gone from the Custom catalogue entirely.
    expect(AVAILABLE_CUSTOM_MODES.has("freehand")).toBe(false);
    // Every catalogued custom mode is now armable.
    expect(AVAILABLE_CUSTOM_MODES.size).toBe(8);
  });

  it("attaches an unavailableHint to every disabled custom mode", () => {
    for (const def of [...CUSTOM_MODES_STANDARD, ...CUSTOM_MODES_ADVANCED]) {
      if (!def.available) {
        expect(def.unavailableHint, `${def.id} missing hint`).toBeTruthy();
      }
    }
  });
});

describe("visibleOptionKeys", () => {
  const ALL = new Set(["preview", "clipboard", "cursor", "enhance", "delay"]);

  it("returns every option for non-custom types", () => {
    expect(visibleOptionKeys("region", null)).toEqual(ALL);
    expect(visibleOptionKeys("window", null)).toEqual(ALL);
    expect(visibleOptionKeys("fullscreen", null)).toEqual(ALL);
  });

  it("returns only delay for color/palette/text-only modes", () => {
    expect(visibleOptionKeys("custom", "color-picker")).toEqual(
      new Set(["delay"])
    );
    expect(visibleOptionKeys("custom", "palette-capture")).toEqual(
      new Set(["delay"])
    );
    expect(visibleOptionKeys("custom", "grab-text")).toEqual(
      new Set(["delay"])
    );
  });

  it("returns only preview for clipboard ingest", () => {
    expect(visibleOptionKeys("custom", "clipboard")).toEqual(
      new Set(["preview"])
    );
  });

  it("drops cursor for the recording modes", () => {
    expect(visibleOptionKeys("custom", "scrolling-window")).toEqual(
      new Set(["preview", "clipboard", "enhance", "delay"])
    );
    expect(visibleOptionKeys("custom", "panoramic")).toEqual(
      new Set(["preview", "clipboard", "enhance", "delay"])
    );
  });

  it("drops enhance for the modes that produce no image", () => {
    // Color/palette/text modes yield swatches or a string — there are no
    // captured pixels for the enhance pass to run over.
    for (const mode of ["color-picker", "palette-capture", "grab-text"] as const) {
      expect(visibleOptionKeys("custom", mode).has("enhance")).toBe(false);
    }
    expect(visibleOptionKeys("custom", "clipboard").has("enhance")).toBe(false);
  });

  it("falls back to every option for unrecognized custom modes", () => {
    expect(visibleOptionKeys("custom", null)).toEqual(ALL);
    expect(visibleOptionKeys("custom", "object")).toEqual(ALL);
    expect(visibleOptionKeys("custom", "freehand")).toEqual(ALL);
  });
});

describe("DEFAULT_TOGGLES", () => {
  it("matches the legacy defaults", () => {
    expect(DEFAULT_TOGGLES).toEqual({
      preview: true,
      clipboard: false,
      cursor: false,
      enhance: false,
      delay: false,
    });
  });
});

describe("installation gating", () => {
  /** Capabilities with everything on except the named flags. */
  function caps(overrides: Partial<Capabilities> = {}): Capabilities {
    return { ...UNMANAGED_PROFILE.capabilities, ...overrides };
  }

  it("treats every mode as installed on an unmanaged install", () => {
    // Portable builds and development runs have no installer answers, so
    // nothing may be hidden.
    for (const def of [...CUSTOM_MODES_STANDARD, ...CUSTOM_MODES_ADVANCED]) {
      expect(isCustomModeInstalled(def.id, caps()), def.id).toBe(true);
    }
  });

  it("reports grab-text as not installed when OCR was declined", () => {
    expect(isCustomModeInstalled("grab-text", caps({ textRecognition: false }))).toBe(
      false
    );
  });

  it("leaves the other modes alone when OCR was declined", () => {
    // Only Grab Text depends on the OCR component — a declined component must
    // not take unrelated modes down with it.
    const declined = caps({ textRecognition: false });
    for (const def of [...CUSTOM_MODES_STANDARD, ...CUSTOM_MODES_ADVANCED]) {
      if (def.id === "grab-text") continue;
      expect(isCustomModeInstalled(def.id, declined), def.id).toBe(true);
    }
  });

  it("requires a mode to be both built and installed to be usable", () => {
    expect(isCustomModeUsable("grab-text", caps())).toBe(true);
    expect(isCustomModeUsable("grab-text", caps({ textRecognition: false }))).toBe(
      false
    );
    // A mode the build doesn't implement stays unusable however the install
    // was configured.
    expect(isCustomModeUsable("freehand", caps())).toBe(false);
  });
});
