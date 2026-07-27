import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWindowActivity } from "./useWindowActivity";

// The hook reads document.visibilityState; jsdom's is read-only, so we
// install a configurable getter we can flip per-test. Local literal type
// (rather than the DOM-global `DocumentVisibilityState`) to satisfy the
// `no-undef` lint rule — same pattern the sibling hook tests use.
let visibility: "visible" | "hidden" = "visible";

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  delete document.documentElement.dataset.idle;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.idle;
});

const idle = () => document.documentElement.dataset.idle;

describe("useWindowActivity", () => {
  it("starts active when the window has focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    renderHook(() => useWindowActivity());
    expect(idle()).toBe("false");
  });

  it("goes idle on blur and active again on focus (focus-bearing window)", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    renderHook(() => useWindowActivity());
    expect(idle()).toBe("false");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(idle()).toBe("true");

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(idle()).toBe("false");
  });

  it("goes idle when the document is hidden, regardless of focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    renderHook(() => useWindowActivity());
    expect(idle()).toBe("false");

    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(idle()).toBe("true");

    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(idle()).toBe("false");
  });

  it("keeps a never-focused but visible window active (toast / countdown)", () => {
    // Window opened in the background and never took focus: it must still
    // animate while visible, so blur must NOT mark it idle — only hiding
    // it should.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    renderHook(() => useWindowActivity());
    expect(idle()).toBe("false");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(idle()).toBe("false");

    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(idle()).toBe("true");
  });
});
