import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { shareCapture } from "./share";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("shareCapture", () => {
  it("invokes share_capture with the path + target", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await shareCapture("C:\\shots\\Region - 1.png", "reveal");
    expect(invokeMock).toHaveBeenCalledWith("share_capture", {
      path: "C:\\shots\\Region - 1.png",
      target: "reveal",
    });
  });

  it("passes each target through verbatim", async () => {
    // The wire values are kebab-case to match the Rust enum — a silent
    // rename here would deserialize-fail on the backend.
    for (const target of ["reveal", "open", "copy-path"] as const) {
      invokeMock.mockResolvedValueOnce(undefined);
      await shareCapture("/tmp/x.png", target);
      expect(invokeMock).toHaveBeenLastCalledWith("share_capture", {
        path: "/tmp/x.png",
        target,
      });
    }
  });

  it("propagates a backend rejection to the caller", async () => {
    // A missing file is a real error, not a silent no-op — the action
    // bar surfaces it as a toast.
    invokeMock.mockRejectedValueOnce(new Error("not a file"));
    await expect(shareCapture("/tmp/gone.png", "open")).rejects.toThrow(
      "not a file"
    );
  });
});
