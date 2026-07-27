import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useCaptureStore } from "../state/captureStore";
import { useSpaceTrigger } from "./useSpaceTrigger";

const initialState = useCaptureStore.getState();

function pressSpace(target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    code: "Space",
    key: " ",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useSpaceTrigger", () => {
  beforeEach(() => {
    useCaptureStore.setState(initialState, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("fires onTrigger and preventDefaults when Space is pressed", () => {
    const onTrigger = vi.fn();
    renderHook(() => useSpaceTrigger(onTrigger));

    const event = pressSpace();
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores Space when focus is in an INPUT", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const onTrigger = vi.fn();
    renderHook(() => useSpaceTrigger(onTrigger));

    pressSpace(input);
    expect(onTrigger).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it("ignores Space when focus is on a BUTTON", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    const onTrigger = vi.fn();
    renderHook(() => useSpaceTrigger(onTrigger));

    pressSpace(button);
    expect(onTrigger).not.toHaveBeenCalled();

    document.body.removeChild(button);
  });

  it("ignores Space when nav is not 'capture'", () => {
    useCaptureStore.getState().setNav("history");

    const onTrigger = vi.fn();
    renderHook(() => useSpaceTrigger(onTrigger));

    pressSpace();
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("cleans up the keydown listener on unmount", () => {
    const onTrigger = vi.fn();
    const { unmount } = renderHook(() => useSpaceTrigger(onTrigger));
    unmount();

    pressSpace();
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
