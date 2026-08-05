import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, formatPrefix, redact, setLoggerEnabled } from "./logger";

afterEach(() => {
  setLoggerEnabled(false); // restore the test-mode default (silent)
  vi.restoreAllMocks();
});

describe("redact", () => {
  it("masks values for sensitive keys, case-insensitively", () => {
    const out = redact({
      token: "abc",
      ApiKey: "xyz",
      authorization: "Bearer 1",
      password: "hunter2",
      keep: "visible",
    }) as Record<string, unknown>;

    expect(out.token).toBe("[redacted]");
    expect(out.ApiKey).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.keep).toBe("visible");
  });

  it("masks sensitive keys nested in objects and arrays", () => {
    const out = redact({ list: [{ sessionId: "s", ok: 1 }] }) as {
      list: Array<Record<string, unknown>>;
    };
    expect(out.list[0]?.sessionId).toBe("[redacted]");
    expect(out.list[0]?.ok).toBe(1);
  });

  it("summarizes an Error to name + message (+ code when present)", () => {
    const bare = redact(new Error("boom")) as Record<string, unknown>;
    expect(bare).toEqual({ name: "Error", message: "boom" });

    const withCode = Object.assign(new Error("nope"), { code: "io" });
    expect(redact(withCode)).toEqual({
      name: "Error",
      message: "nope",
      code: "io",
    });
  });

  it("passes primitives through unchanged", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});

describe("formatPrefix", () => {
  it("tags the module name", () => {
    expect(formatPrefix("capture")).toBe("[clippity:capture]");
  });
});

describe("createLogger", () => {
  it("is silent until enabled (test-mode default)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger("x").warn("should not appear");
    expect(spy).not.toHaveBeenCalled();
  });

  it("writes a prefixed line when enabled", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setLoggerEnabled(true);
    createLogger("ipc").error("command failed");
    expect(spy).toHaveBeenCalledWith("[clippity:ipc]", "command failed");
  });

  it("redacts a context object before writing it", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setLoggerEnabled(true);
    createLogger("auth").warn("oops", { token: "secret", id: 7 });
    expect(spy).toHaveBeenCalledWith("[clippity:auth]", "oops", {
      token: "[redacted]",
      id: 7,
    });
  });
});
