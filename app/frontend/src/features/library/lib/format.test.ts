import { describe, expect, it } from "vitest";

import type { CaptureMeta } from "../types";
import {
  captureDetail,
  captureSubtitle,
  dayKey,
  dayLabel,
  formatBytes,
  formatDimensions,
  formatProvenance,
  formatTime,
  startOfDay,
  textStats,
} from "./format";

function meta(over: Partial<CaptureMeta>): CaptureMeta {
  return {
    id: "/tmp/x.png",
    title: "x",
    kind: "image",
    createdAtMs: 0,
    sizeBytes: 0,
    trashed: false,
    ...over,
  };
}

describe("textStats", () => {
  it("counts characters, whitespace-separated words and lines", () => {
    expect(textStats("one two\nthree")).toEqual({
      characters: 13,
      words: 3,
      lines: 2,
    });
  });

  it("counts no words in blank or whitespace-only text", () => {
    // `"".split(/\s+/)` is `[""]` — the classic off-by-one here.
    expect(textStats("").words).toBe(0);
    expect(textStats("   \n  ").words).toBe(0);
  });
});

describe("captureDetail", () => {
  it("describes a file-backed capture by its pixels", () => {
    expect(captureDetail(meta({ width: 1920, height: 1080 }))).toBe(
      "1920×1080"
    );
  });

  it("describes a color by its RGB, not the hex its title already is", () => {
    const color = { hex: "#ff6e4a", r: 255, g: 110, b: 74 };
    expect(
      captureDetail(meta({ kind: "color", title: "#ff6e4a", color }))
    ).toBe("rgb(255, 110, 74)");
  });

  it("describes a palette by how many colors it holds", () => {
    const swatch = (hex: string) => ({ hex, r: 0, g: 0, b: 0 });
    expect(
      captureDetail(
        meta({ kind: "palette", palette: [swatch("#000"), swatch("#fff")] })
      )
    ).toBe("2 colors");
    expect(
      captureDetail(meta({ kind: "palette", palette: [swatch("#000")] }))
    ).toBe("1 color");
  });

  it("describes a text entry by its word count", () => {
    expect(captureDetail(meta({ kind: "text", text: "hello there" }))).toBe(
      "2 words"
    );
  });

  it("is empty when the payload it would describe is missing", () => {
    // Callers drop the line rather than print a dangling separator.
    expect(captureDetail(meta({ kind: "color" }))).toBe("");
    expect(captureDetail(meta({ kind: "palette", palette: [] }))).toBe("");
    expect(captureDetail(meta({}))).toBe("");
  });
});

describe("captureSubtitle", () => {
  it("prefixes the kind badge", () => {
    expect(captureSubtitle(meta({ width: 1920, height: 1080 }))).toBe(
      "PNG • 1920×1080"
    );
  });

  it("is the badge alone when there is no detail", () => {
    expect(captureSubtitle(meta({}))).toBe("PNG");
  });
});

describe("formatDimensions", () => {
  it("renders width × height", () => {
    expect(formatDimensions(1920, 1080)).toBe("1920×1080");
  });

  it("is empty when either side is missing or zero", () => {
    expect(formatDimensions(undefined, 1080)).toBe("");
    expect(formatDimensions(1920, undefined)).toBe("");
    expect(formatDimensions(0, 0)).toBe("");
    expect(formatDimensions()).toBe("");
  });
});

describe("formatProvenance", () => {
  it("joins every known part in order", () => {
    expect(
      formatProvenance({
        sourceWindow: "GitHub - PR #42 - Chrome",
        sourceApp: "Chrome",
        mode: "Region",
        width: 1920,
        height: 1080,
        monitor: "Display 2",
        preset: "Docs shot",
      })
    ).toBe(
      "GitHub - PR #42 - Chrome · Chrome · Region · 1920×1080 · Display 2 · Docs shot"
    );
  });

  it("skips what the backend could not resolve", () => {
    // A protected process yields no app; an editor export no dimensions.
    expect(formatProvenance({ mode: "Edited" })).toBe("Edited");
    expect(formatProvenance({ sourceApp: "Code", mode: "Region" })).toBe(
      "Code · Region"
    );
  });

  it("names the display and the preset when they are known", () => {
    // Most captures are interactive, so a display without a preset is
    // the common shape — the tail must not leave a dangling separator.
    expect(formatProvenance({ mode: "Region", monitor: "Display 1" })).toBe(
      "Region · Display 1"
    );
    // A clipboard ingest has a preset route but no screen of origin.
    expect(formatProvenance({ mode: "Fullscreen", preset: "Daily" })).toBe(
      "Fullscreen · Daily"
    );
  });

  it("is empty for a capture with no record at all", () => {
    // Passed straight to `title=`, so this must yield no tooltip rather
    // than an empty one.
    expect(formatProvenance({})).toBe("");
  });

  it("treats a blank field as absent", () => {
    expect(formatProvenance({ sourceApp: "   ", mode: "Region" })).toBe(
      "Region"
    );
  });
});

describe("formatBytes", () => {
  it("renders bytes under 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("renders KB with no decimals", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB"); // 1.5 → toFixed(0) rounds
    expect(formatBytes(1024 * 900)).toBe("900 KB");
  });

  it("renders MB with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  it("renders GB with one decimal", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 3.2)).toBe("3.2 GB");
  });
});

describe("formatTime", () => {
  it("returns empty string for a zero timestamp", () => {
    expect(formatTime(0)).toBe("");
  });

  it("renders 12-hour clock with AM/PM", () => {
    // Construct a known local time: 2024-01-01 15:07 local.
    const ms = new Date(2024, 0, 1, 15, 7).getTime();
    expect(formatTime(ms)).toBe("3:07 PM");
  });

  it("renders midnight as 12 AM", () => {
    const ms = new Date(2024, 0, 1, 0, 5).getTime();
    expect(formatTime(ms)).toBe("12:05 AM");
  });

  it("renders noon as 12 PM", () => {
    const ms = new Date(2024, 0, 1, 12, 0).getTime();
    expect(formatTime(ms)).toBe("12:00 PM");
  });
});

describe("startOfDay / dayKey", () => {
  it("collapses any time on a day to local midnight", () => {
    const morning = new Date(2024, 5, 15, 8, 30).getTime();
    const evening = new Date(2024, 5, 15, 22, 45).getTime();
    expect(startOfDay(morning)).toBe(startOfDay(evening));
    expect(dayKey(morning)).toBe(dayKey(evening));
  });

  it("dayKey equals startOfDay", () => {
    const ms = new Date(2024, 5, 15, 8, 30).getTime();
    expect(dayKey(ms)).toBe(startOfDay(ms));
  });
});

describe("dayLabel", () => {
  const now = new Date(2024, 5, 15, 12, 0).getTime();

  it("labels the same day as Today", () => {
    const ms = new Date(2024, 5, 15, 9, 0).getTime();
    expect(dayLabel(ms, now)).toBe("Today");
  });

  it("labels the prior day as Yesterday", () => {
    const ms = new Date(2024, 5, 14, 9, 0).getTime();
    expect(dayLabel(ms, now)).toBe("Yesterday");
  });

  it("labels 2-6 days ago as a weekday name", () => {
    const ms = new Date(2024, 5, 12, 9, 0).getTime(); // 3 days before
    const label = dayLabel(ms, now);
    // Locale-dependent weekday name; just assert it's not Today/
    // Yesterday/a full date.
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label).not.toContain(",");
  });

  it("labels a week+ ago as a formatted date", () => {
    const ms = new Date(2024, 4, 1, 9, 0).getTime(); // ~6 weeks before
    const label = dayLabel(ms, now);
    // Formatted date includes the year.
    expect(label).toContain("2024");
  });
});
