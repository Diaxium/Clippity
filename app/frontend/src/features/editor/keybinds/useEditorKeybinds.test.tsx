import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../state/editorStore";
import {
  __resetNodeIdForTests,
  makeRectangle,
  type RectangleNode,
  type SceneNode,
} from "../types";
import type { KeybindApi } from "./keybindTypes";
import { useEditorKeybinds } from "./useEditorKeybinds";

const api: KeybindApi & Record<string, ReturnType<typeof vi.fn>> = {
  exportImage: vi.fn(),
  exportOptions: vi.fn(() => useEditorStore.getState().requestExport()),
  saveDocument: vi.fn(),
  copyFlattened: vi.fn(),
  toggleHelp: vi.fn(() => useEditorStore.getState().toggleHelp()),
};

function Harness() {
  useEditorKeybinds(true, api);
  return <input data-testid="field" />;
}

interface KeyInit {
  key: string;
  code: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

const state = () => useEditorStore.getState();
const press = (init: KeyInit) => act(() => void fireEvent.keyDown(window, init));
const release = (init: KeyInit) =>
  act(() => void fireEvent.keyUp(window, init));

interface Seed {
  a: RectangleNode;
  b: RectangleNode;
}
function seed(): Seed {
  __resetNodeIdForTests();
  const a = makeRectangle({ x: 0, y: 0, width: 100, height: 100 }, { name: "A" });
  const b = makeRectangle(
    { x: 300, y: 0, width: 100, height: 100 },
    { name: "B" }
  );
  const nodes: Record<string, SceneNode> = { [a.id]: a, [b.id]: b };
  state().loadScene({ rootIds: [a.id, b.id], nodes, docName: "T", sourceId: null });
  return { a, b };
}

beforeEach(() => {
  seed();
  for (const fn of Object.values(api)) fn.mockClear();
});
afterEach(cleanup);

describe("tool shortcuts", () => {
  it("V selects the move/select tool; T the text tool; A the arrow tool", () => {
    render(<Harness />);
    state().setTool("rectangle");
    press({ key: "v", code: "KeyV" });
    expect(state().tool).toBe("select");
    press({ key: "t", code: "KeyT" });
    expect(state().tool).toBe("text");
    press({ key: "a", code: "KeyA" });
    expect(state().tool).toBe("arrow");
  });

  it("P selects pen and I the image tool (design-mode tools)", () => {
    render(<Harness />);
    state().setMode("design");
    press({ key: "p", code: "KeyP" });
    expect(state().tool).toBe("pen");
    press({ key: "i", code: "KeyI" });
    expect(state().tool).toBe("image");
  });

  it("does not switch tools while typing in an input", () => {
    const { getByTestId } = render(<Harness />);
    state().setTool("rectangle");
    act(() => void fireEvent.keyDown(getByTestId("field"), { key: "v", code: "KeyV" }));
    expect(state().tool).toBe("rectangle");
  });

  it("does not switch tools for a mode-unavailable tool", () => {
    render(<Harness />);
    state().setMode("design"); // blur is annotate-only
    state().setTool("rectangle");
    press({ key: "b", code: "KeyB" });
    expect(state().tool).toBe("rectangle");
  });
});

describe("temporary pan (Space)", () => {
  it("activates pan while held and restores the tool (unchanged) on release", () => {
    render(<Harness />);
    state().setTool("rectangle");
    press({ key: " ", code: "Space" });
    expect(state().tempPan).toBe(true);
    expect(state().tool).toBe("rectangle"); // tool is preserved, not swapped
    release({ key: " ", code: "Space" });
    expect(state().tempPan).toBe(false);
    expect(state().tool).toBe("rectangle");
  });
});

describe("history", () => {
  it("Mod+Z undoes and Mod+Shift+Z redoes", () => {
    const { a } = seed();
    render(<Harness />);
    state().updateNode(a.id, { x: 50 });
    expect(state().nodes[a.id]!.x).toBe(50);
    press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(state().nodes[a.id]!.x).toBe(0);
    press({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true });
    expect(state().nodes[a.id]!.x).toBe(50);
  });
});

describe("selection editing", () => {
  it("Delete removes the selected node", () => {
    const { a } = seed();
    render(<Harness />);
    state().select([a.id]);
    press({ key: "Delete", code: "Delete" });
    expect(state().nodes[a.id]).toBeUndefined();
  });

  it("Mod+D duplicates the selection", () => {
    const { a } = seed();
    render(<Harness />);
    state().select([a.id]);
    press({ key: "d", code: "KeyD", ctrlKey: true });
    expect(state().rootIds).toHaveLength(3);
  });

  it("Mod+] brings forward and Mod+[ sends backward", () => {
    const { a, b } = seed();
    render(<Harness />);
    state().select([a.id]); // a is at the back (index 0)
    press({ key: "]", code: "BracketRight", ctrlKey: true });
    expect(state().rootIds).toEqual([b.id, a.id]);
    press({ key: "[", code: "BracketLeft", ctrlKey: true });
    expect(state().rootIds).toEqual([a.id, b.id]);
  });

  it("arrow keys nudge 1px; Shift+arrow nudges 10px", () => {
    const { a } = seed();
    render(<Harness />);
    state().select([a.id]);
    press({ key: "ArrowRight", code: "ArrowRight" });
    expect(state().nodes[a.id]!.x).toBe(1);
    press({ key: "ArrowDown", code: "ArrowDown", shiftKey: true });
    expect(state().nodes[a.id]!.y).toBe(10);
  });
});

describe("nudge history coalescing", () => {
  it("collapses a burst of nudges into one undo step", () => {
    vi.useFakeTimers();
    try {
      const { a } = seed();
      render(<Harness />);
      state().select([a.id]);
      const before = state().past.length;
      press({ key: "ArrowRight", code: "ArrowRight" });
      press({ key: "ArrowRight", code: "ArrowRight" });
      press({ key: "ArrowRight", code: "ArrowRight" });
      expect(state().nodes[a.id]!.x).toBe(3);
      expect(state().past.length).toBe(before + 1); // single snapshot
      act(() => void vi.advanceTimersByTime(600)); // flush the coalesce timer
      state().undo();
      expect(state().nodes[a.id]!.x).toBe(0); // whole burst reverts at once
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("view", () => {
  it("Shift+1 zooms to fit; Shift+2 zooms to the selection", () => {
    const { a } = seed();
    render(<Harness />);
    state().setCanvasSize(800, 600);
    press({ key: "1", code: "Digit1", shiftKey: true });
    const fit = state().viewport;
    expect(fit.zoom).toBeGreaterThan(0);

    state().select([a.id]);
    press({ key: "2", code: "Digit2", shiftKey: true });
    expect(state().viewport.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(state().viewport.panX)).toBe(true);
  });
});

describe("file / export + help", () => {
  it("routes export/clipboard/save combos to the api", () => {
    render(<Harness />);
    press({ key: "e", code: "KeyE", ctrlKey: true });
    expect(api.exportImage).toHaveBeenCalledTimes(1);
    press({ key: "c", code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(api.copyFlattened).toHaveBeenCalledTimes(1);
    press({ key: "e", code: "KeyE", ctrlKey: true, shiftKey: true });
    expect(api.exportOptions).toHaveBeenCalledTimes(1);
    press({ key: "s", code: "KeyS", ctrlKey: true });
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
  });

  it("? toggles help, suppresses other keys while open, and Esc closes it", () => {
    render(<Harness />);
    state().setTool("rectangle");
    press({ key: "/", code: "Slash", shiftKey: true });
    expect(state().helpOpen).toBe(true);
    // While help is open, tool letters are inert.
    press({ key: "v", code: "KeyV" });
    expect(state().tool).toBe("rectangle");
    press({ key: "Escape", code: "Escape" });
    expect(state().helpOpen).toBe(false);
  });
});
