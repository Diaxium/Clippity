import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "./NumberField";

// jsdom has no coordinate-carrying PointerEvent and no pointer capture. Back
// PointerEvent with MouseEvent so clientX/Y + modifiers reach the handlers, and
// stub capture to no-ops. (Mirrors editorCanvas.test.tsx.)
interface PointerInit {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
  shiftKey?: boolean;
  altKey?: boolean;
}
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, props: PointerInit = {}) {
      super(type, props);
      this.pointerId = props.pointerId ?? 1;
    }
  }
  globalThis.PointerEvent =
    PointerEventPolyfill as unknown as typeof PointerEvent;
});

afterEach(cleanup);

/** Drag the field horizontally from `fromX` to `toX` at one pointer id. */
function scrub(
  field: HTMLElement,
  fromX: number,
  toX: number,
  opts: PointerInit = {}
): void {
  fireEvent.pointerDown(field, {
    pointerId: 1,
    button: 0,
    clientX: fromX,
    clientY: 10,
  });
  fireEvent.pointerMove(field, {
    pointerId: 1,
    clientX: toX,
    clientY: 10,
    ...opts,
  });
  fireEvent.pointerUp(field, { pointerId: 1, clientX: toX, clientY: 10 });
}

describe("NumberField drag-scrub", () => {
  it("scrubs a suffix-only field (the Opacity case) on horizontal drag", () => {
    const onChange = vi.fn();
    const { container } = render(
      <NumberField value={50} suffix="%" onChange={onChange} />
    );
    // No label/icon handle — the whole field is the scrub surface.
    expect(container.querySelector("span.cursor-ew-resize")).toBeNull();
    scrub(container.firstChild as HTMLElement, 100, 110); // +10px → +10
    expect(onChange).toHaveBeenLastCalledWith(60);
  });

  it("ignores presses below the movement threshold (so clicks still type)", () => {
    const onChange = vi.fn();
    const { container } = render(<NumberField value={50} onChange={onChange} />);
    scrub(container.firstChild as HTMLElement, 100, 102); // 2px ≤ threshold
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores vertical-dominant drags so the panel can scroll", () => {
    const onChange = vi.fn();
    const { container } = render(<NumberField value={50} onChange={onChange} />);
    const field = container.firstChild as HTMLElement;
    fireEvent.pointerDown(field, {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 104, clientY: 50 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 104, clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("coarsens by ×10 while Shift is held", () => {
    const onChange = vi.fn();
    const { container } = render(<NumberField value={0} onChange={onChange} />);
    scrub(container.firstChild as HTMLElement, 100, 105, { shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(50); // 5px × 10
  });

  it("refines by ×0.1 while Alt is held", () => {
    const onChange = vi.fn();
    const { container } = render(<NumberField value={0} onChange={onChange} />);
    scrub(container.firstChild as HTMLElement, 100, 110, { altKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1); // 10px × 0.1
  });

  it("does not scrub a disabled field", () => {
    const onChange = vi.fn();
    const { container } = render(
      <NumberField value={50} disabled onChange={onChange} />
    );
    scrub(container.firstChild as HTMLElement, 100, 120);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("NumberField keyboard", () => {
  it("nudges by ±1 on Arrow keys", () => {
    const onChange = vi.fn();
    render(<NumberField value={50} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(51);
  });

  it("nudges by ±10 with Shift and clamps to max", () => {
    const onChange = vi.fn();
    render(<NumberField value={95} max={100} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "ArrowUp",
      shiftKey: true,
    });
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("evaluates an arithmetic expression on commit", () => {
    const onChange = vi.fn();
    render(<NumberField value={10} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "100/2" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(50);
  });

  it("strips a trailing suffix before evaluating", () => {
    const onChange = vi.fn();
    render(<NumberField value={10} suffix="%" onChange={onChange} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "75%" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith(75);
  });

  it("reverts to the prior value on invalid input", () => {
    const onChange = vi.fn();
    render(<NumberField value={10} onChange={onChange} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });
});

describe("NumberField history transactions", () => {
  it("wraps a scrub in a single begin/endHistory transaction", () => {
    const begin = vi.spyOn(useEditorStore.getState(), "beginHistory");
    const end = vi.spyOn(useEditorStore.getState(), "endHistory");
    const { container } = render(<NumberField value={0} onChange={() => {}} />);
    scrub(container.firstChild as HTMLElement, 100, 120);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    begin.mockRestore();
    end.mockRestore();
  });

  it("opens one transaction for an arrow-key nudge burst, closing on key-up", () => {
    const begin = vi.spyOn(useEditorStore.getState(), "beginHistory");
    const end = vi.spyOn(useEditorStore.getState(), "endHistory");
    render(<NumberField value={0} onChange={() => {}} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" }); // auto-repeat reuses the txn
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();
    fireEvent.keyUp(input, { key: "ArrowUp" });
    expect(end).toHaveBeenCalledTimes(1);
    begin.mockRestore();
    end.mockRestore();
  });
});
