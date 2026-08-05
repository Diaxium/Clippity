import { describe, expect, it } from "vitest";

import type { LogLine } from "@services/tauri/clients/developer";

import { filterLines } from "./LogViewer";

function line(overrides: Partial<LogLine>): LogLine {
  return {
    seq: 0,
    timestamp: "2026-08-04T12:00:00.000000Z",
    level: "info",
    message: "something happened",
    ...overrides,
  };
}

describe("filterLines", () => {
  const lines: LogLine[] = [
    line({ seq: 1, level: "debug", message: "overlay snapshot decoded" }),
    line({ seq: 2, level: "info", message: "capture saved" }),
    line({ seq: 3, level: "warn", message: "recorder dropped a frame" }),
    line({ seq: 4, level: "error", message: "capture failed" }),
    // A panic backtrace: no timestamp, no level.
    line({ seq: 5, level: "", timestamp: "", message: "  3: core::panicking" }),
  ];

  it("passes everything at the default filter", () => {
    expect(filterLines(lines, "all", "")).toHaveLength(5);
  });

  it("applies the level as a floor", () => {
    const warnAndUp = filterLines(lines, "warn", "");
    expect(warnAndUp.map((l) => l.seq)).toEqual([3, 4, 5]);
  });

  it("keeps level-less lines whatever the floor", () => {
    // Those are the lines a crash produces — filtering them out would
    // hide exactly what the viewer exists for.
    const errorsOnly = filterLines(lines, "error", "");
    expect(errorsOnly.map((l) => l.seq)).toEqual([4, 5]);
  });

  it("matches the query case-insensitively against the message", () => {
    expect(filterLines(lines, "all", "DROPPED").map((l) => l.seq)).toEqual([3]);
  });

  it("combines the level floor and the query", () => {
    expect(filterLines(lines, "warn", "capture").map((l) => l.seq)).toEqual([
      4,
    ]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterLines(lines, "all", "   ")).toHaveLength(5);
  });
});
