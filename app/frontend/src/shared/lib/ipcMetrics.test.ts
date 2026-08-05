import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_SAMPLES,
  approximateBytes,
  beginIpcCall,
  clearIpcSamples,
  configureIpcMetrics,
  endIpcCall,
  getIpcSamples,
  ipcMetricsEnabled,
  pendingIpcCalls,
  recordIpcSample,
  resetIpcMetrics,
  subscribeIpcMetrics,
  summarizeIpc,
  type IpcSample,
} from "./ipcMetrics";

function sample(overrides: Partial<IpcSample> = {}): Omit<IpcSample, "seq"> {
  return {
    command: "settings_get",
    ms: 10,
    ok: true,
    requestBytes: 0,
    responseBytes: 0,
    at: 1_000,
    ...overrides,
  };
}

describe("ipcMetrics recording", () => {
  beforeEach(() => resetIpcMetrics());

  it("records nothing until it is armed", () => {
    // The recorder sits on the path of every IPC call the app makes, so
    // "off" has to mean off, not "collected but hidden".
    recordIpcSample({ command: "settings_get", ms: 5, ok: true });
    expect(getIpcSamples()).toHaveLength(0);
    expect(ipcMetricsEnabled()).toBe(false);
  });

  it("records once armed", () => {
    configureIpcMetrics({ enabled: true });
    recordIpcSample({ command: "settings_get", ms: 5, ok: true });
    const [first] = getIpcSamples();
    expect(first?.command).toBe("settings_get");
    expect(first?.ok).toBe(true);
  });

  it("drops what it collected when it is disarmed", () => {
    // A rolling window of command metadata should not outlive the
    // switch that permitted collecting it.
    configureIpcMetrics({ enabled: true });
    recordIpcSample({ command: "a", ms: 1, ok: true });
    configureIpcMetrics({ enabled: false });
    expect(getIpcSamples()).toHaveLength(0);
  });

  it("keeps only the most recent window", () => {
    configureIpcMetrics({ enabled: true });
    for (let i = 0; i < MAX_SAMPLES + 20; i += 1) {
      recordIpcSample({ command: `cmd_${i}`, ms: 1, ok: true });
    }
    const samples = getIpcSamples();
    expect(samples).toHaveLength(MAX_SAMPLES);
    // The oldest 20 fell off the front, not the back.
    expect(samples[samples.length - 1]?.command).toBe(
      `cmd_${MAX_SAMPLES + 19}`
    );
  });

  it("hands out a new array on every record", () => {
    // The inspector reads this through `useSyncExternalStore`, which
    // compares snapshots by reference: mutating in place would leave the
    // table frozen while calls kept arriving.
    configureIpcMetrics({ enabled: true });
    const before = getIpcSamples();
    recordIpcSample({ command: "a", ms: 1, ok: true });
    expect(getIpcSamples()).not.toBe(before);
  });

  it("notifies subscribers on record and on clear", () => {
    configureIpcMetrics({ enabled: true });
    const listener = vi.fn();
    const unsubscribe = subscribeIpcMetrics(listener);
    recordIpcSample({ command: "a", ms: 1, ok: true });
    expect(listener).toHaveBeenCalledTimes(1);
    clearIpcSamples();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    recordIpcSample({ command: "b", ms: 1, ok: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("counts in-flight calls whether or not recording is armed", () => {
    // "How many commands are stuck?" matters most exactly when nobody
    // thought to arm the recorder first.
    expect(pendingIpcCalls()).toBe(0);
    beginIpcCall();
    beginIpcCall();
    expect(pendingIpcCalls()).toBe(2);
    endIpcCall();
    expect(pendingIpcCalls()).toBe(1);
    endIpcCall();
    endIpcCall(); // one too many — must not go negative
    expect(pendingIpcCalls()).toBe(0);
  });
});

describe("approximateBytes", () => {
  it("sizes a payload without throwing on one it cannot encode", () => {
    expect(approximateBytes({ a: 1 })).toBeGreaterThan(0);
    expect(approximateBytes(undefined)).toBe(0);
    expect(approximateBytes(null)).toBe(0);

    // A circular argument must not turn instrumentation into a failure
    // inside an otherwise-successful call.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(approximateBytes(circular)).toBe(0);
  });
});

describe("summarizeIpc", () => {
  it("returns zeros for an empty window", () => {
    const summary = summarizeIpc([]);
    expect(summary).toEqual({
      total: 0,
      failed: 0,
      slow: 0,
      avgMs: 0,
      p95Ms: 0,
      byCommand: [],
    });
  });

  it("counts failures and calls over the threshold", () => {
    const window: IpcSample[] = [
      { seq: 1, ...sample({ ms: 10 }) },
      { seq: 2, ...sample({ ms: 200 }) },
      { seq: 3, ...sample({ ms: 20, ok: false, code: "capture" }) },
    ];
    const summary = summarizeIpc(window, 100);
    expect(summary.total).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.slow).toBe(1);
    expect(summary.avgMs).toBeCloseTo(76.67, 1);
  });

  it("ranks commands by total time, not by average", () => {
    // A 4 ms command called three hundred times is a real cost that a
    // mean hides behind one slow outlier.
    const window: IpcSample[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        seq: i + 1,
        ...sample({ command: "library_thumbnail", ms: 4 }),
      })),
      { seq: 100, ...sample({ command: "media_trim", ms: 150 }) },
    ];
    const summary = summarizeIpc(window);
    expect(summary.byCommand[0]?.command).toBe("library_thumbnail");
    expect(summary.byCommand[0]?.totalMs).toBe(200);
    expect(summary.byCommand[1]?.command).toBe("media_trim");
  });

  it("reports p95 by nearest rank, not by interpolation", () => {
    // With 20 samples the p95 is the 19th measured value — not a number
    // nobody observed.
    const window: IpcSample[] = Array.from({ length: 20 }, (_, i) => ({
      seq: i + 1,
      ...sample({ ms: i + 1 }),
    }));
    expect(summarizeIpc(window).p95Ms).toBe(19);
  });

  it("rolls per-command failures up alongside the calls", () => {
    const window: IpcSample[] = [
      { seq: 1, ...sample({ command: "capture_fullscreen", ms: 30 }) },
      {
        seq: 2,
        ...sample({ command: "capture_fullscreen", ms: 60, ok: false }),
      },
    ];
    const [entry] = summarizeIpc(window).byCommand;
    expect(entry?.calls).toBe(2);
    expect(entry?.failed).toBe(1);
    expect(entry?.maxMs).toBe(60);
    expect(entry?.avgMs).toBe(45);
  });
});
