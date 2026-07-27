import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement matchMedia; the theme store reads it on
// init. Stub a minimal MediaQueryList so `useThemeStore()` doesn't
// throw under Vitest.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom doesn't implement ResizeObserver. The toast feature's
// `useToastResize` hook subscribes to one — stub a minimal observer
// that records the callback so tests can drive it manually.
if (typeof globalThis.ResizeObserver === "undefined") {
  class StubResizeObserver {
    constructor(_cb: ResizeObserverCallback) {
      // Tests that need to drive layout changes should mock
      // ResizeObserver locally and capture the callback. This global
      // stub is just a "doesn't throw on construction" baseline.
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
}

// jsdom implements neither half of the pointer-drag surface, and both gaps
// fail *silently* — a gesture test still renders and still asserts, it just
// never runs the gesture. Both stubs are needed together.
//
// (1) No Pointer Capture API. A handler calling `setPointerCapture` throws, so
// the drag never starts.
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function (pointerId: number) {
    const set = captured.get(this) ?? new Set<number>();
    set.add(pointerId);
    captured.set(this, set);
  };
  Element.prototype.releasePointerCapture = function (pointerId: number) {
    captured.get(this)?.delete(pointerId);
  };
  Element.prototype.hasPointerCapture = function (pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
}

// (2) No `PointerEvent`
// constructor. Testing Library's `fireEvent.pointerDown/Move/Up` therefore
// falls back to a plain Event and *silently drops* `clientX`/`clientY` — a
// pointer-driven gesture (the inspector's dock/undock, panel resize) then sees
// `undefined` coordinates, computes NaN, and no-ops. The test still passes its
// render assertions, so the gesture looks exercised when it never ran.
//
// MouseEvent (which jsdom does implement) already carries the coordinate and
// modifier surface these handlers read, so extend it and add the pointer fields.
if (typeof globalThis.PointerEvent === "undefined") {
  class StubPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.pressure = params.pressure ?? 0;
    }
  }
  globalThis.PointerEvent =
    StubPointerEvent as unknown as typeof PointerEvent;
}
