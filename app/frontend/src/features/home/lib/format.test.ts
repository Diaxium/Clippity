import { describe, expect, it } from "vitest";

import { formatBytes, formatDimensions, formatRelative } from "./format";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelative", () => {
  it("returns empty string for a falsy timestamp", () => {
    expect(formatRelative(0, NOW)).toBe("");
  });

  it("labels sub-minute as 'just now'", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("just now");
  });

  it("labels minutes and hours", () => {
    expect(formatRelative(NOW - 5 * MIN, NOW)).toBe("5m ago");
    expect(formatRelative(NOW - 3 * HOUR, NOW)).toBe("3h ago");
  });

  it("labels the previous day as 'Yesterday' then day counts", () => {
    expect(formatRelative(NOW - 25 * HOUR, NOW)).toBe("Yesterday");
    expect(formatRelative(NOW - 4 * DAY, NOW)).toBe("4d ago");
  });

  it("clamps a future timestamp to 'just now' rather than a negative", () => {
    expect(formatRelative(NOW + 10_000, NOW)).toBe("just now");
  });
});

describe("formatBytes", () => {
  it("scales through the units", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * 1024)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("formatDimensions", () => {
  it("joins with × when both present, else empty", () => {
    expect(formatDimensions(1920, 1080)).toBe("1920×1080");
    expect(formatDimensions(undefined, 1080)).toBe("");
    expect(formatDimensions(1920, undefined)).toBe("");
  });
});
