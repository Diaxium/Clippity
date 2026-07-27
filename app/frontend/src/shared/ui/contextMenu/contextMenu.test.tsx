import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ContextMenuHost } from "./ContextMenuHost";
import { useContextMenuStore } from "./contextMenuStore";
import { fallbackEntries } from "./fallbackEntries";
import { useNativeContextMenu } from "./useNativeContextMenu";
import type {
  ContextMenuAction,
  ContextMenuEntry,
  OpenContextMenu,
} from "./types";

/** Mounts the always-on pieces `Providers` mounts in the real app. */
function Harness() {
  useNativeContextMenu();
  return <ContextMenuHost />;
}

/** The store is driven directly here — regions are covered by their own
 *  feature tests — so opens need wrapping to flush the host's render. */
function openMenu(menu: OpenContextMenu) {
  act(() => useContextMenuStore.getState().open(menu));
}

/** A right-click, returning the event so callers can assert on
 *  `defaultPrevented` — which is the whole contract being tested. */
function rightClick(el: Element) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

/** Entry labels only — the first span; the shortcut hint is a second one. */
function labels(): string[] {
  return screen
    .getAllByRole("menuitem")
    .map((el) => el.querySelector("span")?.textContent?.trim() ?? "");
}

function actionsOf(entries: ContextMenuEntry[]): ContextMenuAction[] {
  return entries.filter((e): e is ContextMenuAction => e !== "divider");
}

beforeEach(() => {
  useContextMenuStore.setState({ menu: null });
  document.body.innerHTML = "";
});

describe("native menu suppression", () => {
  it("preventDefaults every contextmenu event, wherever it originates", () => {
    render(<Harness />);
    const target = document.createElement("div");
    document.body.appendChild(target);

    expect(rightClick(target).defaultPrevented).toBe(true);
  });

  it("suppresses even where no menu is offered", () => {
    render(<Harness />);
    const bare = document.createElement("div");
    document.body.appendChild(bare);

    // Nothing to show here — but the browser menu is still gone, which is
    // the whole point of suppressing unconditionally in the capture phase.
    expect(rightClick(bare).defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the clipboard menu over a text field nobody claimed", () => {
    render(<Harness />);
    const input = document.createElement("input");
    input.value = "hello";
    document.body.appendChild(input);
    input.setSelectionRange(0, 5);

    rightClick(input);

    expect(labels()).toEqual(["Cut", "Copy", "Paste", "Select all"]);
  });

  it("dismisses a stale menu when the next right-click has no entries", () => {
    render(<Harness />);
    openMenu({
      x: 0,
      y: 0,
      entries: [{ id: "a", label: "A", onSelect: () => {} }],
    });

    const bare = document.createElement("div");
    document.body.appendChild(bare);
    rightClick(bare);

    expect(useContextMenuStore.getState().menu).toBeNull();
  });
});

describe("fallbackEntries", () => {
  it("offers the clipboard commands over a text input", () => {
    const input = document.createElement("input");
    input.value = "hello";
    input.setSelectionRange(0, 5);
    document.body.appendChild(input);

    const { entries, field } = fallbackEntries(input);

    expect(actionsOf(entries).map((e) => e.id)).toEqual([
      "cut",
      "copy",
      "paste",
      "select-all",
    ]);
    expect(field?.el).toBe(input);
    expect(field?.start).toBe(0);
    expect(field?.end).toBe(5);
  });

  it("disables cut and copy when nothing in the field is selected", () => {
    const input = document.createElement("input");
    input.value = "hello";
    input.setSelectionRange(2, 2);
    document.body.appendChild(input);

    const byId = Object.fromEntries(
      actionsOf(fallbackEntries(input).entries).map((e) => [e.id, e])
    );

    expect(byId.cut?.disabled).toBe(true);
    expect(byId.copy?.disabled).toBe(true);
    // Paste stays live: whether the clipboard holds text needs an async
    // read, and greying out a Paste that would have worked is worse.
    expect(byId.paste?.disabled).toBe(false);
  });

  it("offers no edit commands on a read-only field", () => {
    const input = document.createElement("input");
    input.value = "hello";
    input.readOnly = true;
    input.setSelectionRange(0, 5);
    document.body.appendChild(input);

    const byId = Object.fromEntries(
      actionsOf(fallbackEntries(input).entries).map((e) => [e.id, e])
    );

    expect(byId.cut?.disabled).toBe(true);
    expect(byId.paste?.disabled).toBe(true);
    expect(byId.copy?.disabled).toBe(false);
  });

  it("ignores non-textual inputs", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);

    expect(fallbackEntries(checkbox).entries).toEqual([]);
  });

  it("offers Copy over selected text outside a field", () => {
    const p = document.createElement("p");
    p.textContent = "a filename worth lifting out";
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const { entries } = fallbackEntries(p);

    expect(actionsOf(entries).map((e) => e.id)).toEqual(["copy-selection"]);
  });

  it("offers nothing over inert chrome", () => {
    window.getSelection()?.removeAllRanges();
    const div = document.createElement("div");
    document.body.appendChild(div);

    expect(fallbackEntries(div).entries).toEqual([]);
  });
});

describe("ContextMenuHost", () => {
  const entries: ContextMenuEntry[] = [
    { id: "open", label: "Open", onSelect: vi.fn() },
    { id: "nope", label: "Nope", disabled: true, onSelect: vi.fn() },
    "divider",
    { id: "trash", label: "Trash", danger: true, onSelect: vi.fn() },
  ];

  it("renders entries and dividers, and closes after running one", () => {
    const onSelect = vi.fn();
    render(<ContextMenuHost />);
    openMenu({
      x: 10,
      y: 10,
      entries: [{ id: "open", label: "Open", onSelect }],
      label: "Actions for Screenshot",
    });

    expect(screen.getByRole("menu")).toHaveAccessibleName(
      "Actions for Screenshot"
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it("does not run a disabled entry", () => {
    const onSelect = vi.fn();
    render(<ContextMenuHost />);
    openMenu({
      x: 0,
      y: 0,
      entries: [{ id: "nope", label: "Nope", disabled: true, onSelect }],
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Nope" }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(useContextMenuStore.getState().menu).not.toBeNull();
  });

  it("closes on Escape", () => {
    render(<ContextMenuHost />);
    openMenu({ x: 0, y: 0, entries });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it("dismisses on a stray keystroke without swallowing it", () => {
    render(<ContextMenuHost />);
    openMenu({ x: 0, y: 0, entries });

    // The menu is often opened over a text field; typing means "done with
    // the menu", and the character still has to reach the input.
    const event = new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(useContextMenuStore.getState().menu).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a bare modifier does not dismiss it", () => {
    render(<ContextMenuHost />);
    openMenu({ x: 0, y: 0, entries });

    fireEvent.keyDown(window, { key: "Shift" });

    expect(useContextMenuStore.getState().menu).not.toBeNull();
  });

  it("closes when the window blurs or a pane scrolls under it", () => {
    render(<ContextMenuHost />);

    openMenu({ x: 0, y: 0, entries });
    fireEvent.blur(window);
    expect(useContextMenuStore.getState().menu).toBeNull();

    openMenu({ x: 0, y: 0, entries });
    fireEvent.scroll(window);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it("arrow keys skip dividers and disabled entries", () => {
    const open = vi.fn();
    const trash = vi.fn();
    render(<ContextMenuHost />);
    openMenu({
      x: 0,
      y: 0,
      entries: [
        { id: "open", label: "Open", onSelect: open },
        { id: "nope", label: "Nope", disabled: true, onSelect: vi.fn() },
        "divider",
        { id: "trash", label: "Trash", onSelect: trash },
      ],
    });

    // Down lands on "Open", down again skips the disabled entry and the
    // divider to reach "Trash".
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(trash).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("ArrowUp from nothing highlighted starts at the last entry", () => {
    const trash = vi.fn();
    render(<ContextMenuHost />);
    openMenu({
      x: 0,
      y: 0,
      entries: [
        { id: "open", label: "Open", onSelect: vi.fn() },
        { id: "trash", label: "Trash", onSelect: trash },
      ],
    });

    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(trash).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry order it was given", () => {
    render(<ContextMenuHost />);
    openMenu({ x: 0, y: 0, entries });

    expect(labels()).toEqual(["Open", "Nope", "Trash"]);
  });
});
