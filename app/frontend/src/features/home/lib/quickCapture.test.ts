import { describe, expect, it } from "vitest";

import {
  comboSigKey,
  eventSigKey,
} from "@features/editor/keybinds/keybindUtils";

import {
  UNMANAGED_PROFILE,
  type Capabilities,
} from "@services/tauri/clients/provisioning";

import {
  QUICK_CAPTURE_ACTIONS,
  unavailabilityOf,
  type QuickCaptureId,
} from "./quickCapture";

/** Minimal stand-in for the fields `eventSigKey` reads off a keydown. */
function keyEvent(
  code: string,
  mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return {
    code,
    key: "",
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  } as KeyboardEvent;
}

describe("QUICK_CAPTURE_ACTIONS", () => {
  it("marks every launcher action available, each with a combo", () => {
    // Record and GIF joined Screenshot and Window when the recorder
    // landed (ADR 0031); all four dispatch to a real backend call.
    const available = QUICK_CAPTURE_ACTIONS.filter((a) => a.available);
    expect(available.map((a) => a.id)).toEqual([
      "screenshot",
      "window",
      "record",
      "gif",
    ]);
    expect(available.every((a) => !!a.combo)).toBe(true);
  });

  it("gives every action a distinct combo", () => {
    // Two launchers sharing a combo would make one of them dead —
    // whichever the matcher happened to find first.
    const combos = QUICK_CAPTURE_ACTIONS.filter((a) => a.combo).map(
      (a) => a.combo
    );
    expect(new Set(combos).size).toBe(combos.length);
  });

  it("an action without a backend would carry no shortcut", () => {
    // The "Soon" path is unused today but still has to hold: a card
    // that can't act must not bind a hotkey that silently does nothing.
    for (const action of QUICK_CAPTURE_ACTIONS) {
      if (!action.available) expect(action.combo).toBeUndefined();
    }
  });

  it("has exactly one featured (primary) action", () => {
    expect(QUICK_CAPTURE_ACTIONS.filter((a) => a.featured)).toHaveLength(1);
  });

  it("resolves Ctrl+1 / Ctrl+2 to the Screenshot / Window bindings", () => {
    const byId = Object.fromEntries(
      QUICK_CAPTURE_ACTIONS.filter((a) => a.combo).map((a) => [
        a.id,
        comboSigKey(a.combo!),
      ])
    );
    expect(eventSigKey(keyEvent("Digit1", { ctrl: true }))).toBe(
      byId.screenshot
    );
    expect(eventSigKey(keyEvent("Digit2", { ctrl: true }))).toBe(byId.window);
    // Cmd unifies with Ctrl in the shared matcher (Mac parity).
    expect(eventSigKey(keyEvent("Digit1", { meta: true }))).toBe(
      byId.screenshot
    );
  });

  it("does not fire a binding for a bare digit without the modifier", () => {
    const sigs = new Set(
      QUICK_CAPTURE_ACTIONS.filter((a) => a.combo).map((a) =>
        comboSigKey(a.combo!)
      )
    );
    expect(sigs.has(eventSigKey(keyEvent("Digit1")))).toBe(false);
  });
});

describe("unavailabilityOf", () => {
  /** Capabilities with everything on except the named flags. */
  function caps(overrides: Partial<Capabilities> = {}): Capabilities {
    return { ...UNMANAGED_PROFILE.capabilities, ...overrides };
  }

  function action(id: QuickCaptureId) {
    const found = QUICK_CAPTURE_ACTIONS.find((a) => a.id === id);
    if (!found) throw new Error(`no such action: ${id}`);
    return found;
  }

  it("clears every launcher action on an unmanaged install", () => {
    // No installer answers to honor, so nothing may be disabled for them.
    for (const a of QUICK_CAPTURE_ACTIONS) {
      expect(unavailabilityOf(a, caps()), a.id).toBeNull();
    }
  });

  it("marks GIF not-installed when the encoder was declined", () => {
    expect(unavailabilityOf(action("gif"), caps({ gifRecording: false }))).toBe(
      "not-installed"
    );
  });

  it("leaves video recording usable when only GIF was declined", () => {
    // One session feeds either encoder, so declining GIF must not cost the
    // user MP4 recording too.
    const declined = caps({ gifRecording: false });
    expect(unavailabilityOf(action("record"), declined)).toBeNull();
    expect(unavailabilityOf(action("screenshot"), declined)).toBeNull();
    expect(unavailabilityOf(action("window"), declined)).toBeNull();
  });

  it("reports an unshipped action as soon, not as not-installed", () => {
    // The two have different remedies — telling a user to re-run the
    // installer for a port that hasn't landed would be false advice.
    const unshipped = { ...action("gif"), available: false };
    expect(unavailabilityOf(unshipped, caps({ gifRecording: false }))).toBe(
      "soon"
    );
    expect(unavailabilityOf(unshipped, caps())).toBe("soon");
  });
});
