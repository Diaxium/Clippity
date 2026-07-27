import type { Effect, Paint, SceneNode, Stroke } from "../types";

/**
 * Multi-select reading primitives (Workstream P3).
 *
 * The inspector has always rendered the **primary** selection — `sel[0]` — and
 * disabled the numeric fields whenever more than one node was selected. P3
 * replaces that with Figma's model: a field shows the shared value when the
 * selection agrees and **"Mixed"** when it doesn't, and editing it applies to
 * the whole selection in one undo step.
 *
 * Everything here is pure so the "what does the selection agree on?" question is
 * unit-testable without rendering a panel. The batch *writes* live on the store
 * (`updateNodes`, `updateFills`, `updateStrokes`, `updateEffects`).
 */

/** A property read across a selection. */
export interface Shared<T> {
  /**
   * The primary node's value. Deliberately a real value even when `mixed` — a
   * scrub or arrow-nudge on a mixed field has to start *somewhere*, and the
   * primary is the node the user most recently reached for.
   */
  value: T;
  /** True when any other node in the selection disagrees. */
  mixed: boolean;
}

/**
 * Read `pick` across `items`, reporting the primary's value and whether the
 * rest agree.
 *
 * `identity` projects a value down to what "the same" means for it — the
 * default compares with `Object.is`, which is right for the numbers, strings
 * and booleans that make up most node properties. Structural values (corner
 * radii, callout specs, paint previews) pass a projection instead so two equal
 * objects don't read as mixed purely for being distinct references.
 *
 * Returns `null` for an empty list, so callers bail the same way they already
 * bail on `sel[0]` being undefined.
 */
export function shared<I, T>(
  items: readonly I[],
  pick: (item: I) => T,
  identity: (value: T) => unknown = (v) => v
): Shared<T> | null {
  const first = items[0];
  if (first === undefined) return null;
  const value = pick(first);
  const id = identity(value);
  for (let i = 1; i < items.length; i++) {
    if (!Object.is(identity(pick(items[i]!)), id)) return { value, mixed: true };
  }
  return { value, mixed: false };
}

/**
 * `shared` for values that only make sense on *some* nodes — text properties on
 * a mixed-type selection, a callout's tail angle, a sample's amount. Nodes the
 * picker rejects (returning `undefined`) sit out the comparison entirely rather
 * than reading as a disagreement, which is what lets a selection of three
 * callouts and a rectangle still edit the three tails together.
 *
 * Returns `null` when *no* item carries the property.
 */
export function sharedWhere<I, T>(
  items: readonly I[],
  pick: (item: I) => T | undefined,
  identity: (value: T) => unknown = (v) => v
): Shared<T> | null {
  const present: T[] = [];
  for (const item of items) {
    const v = pick(item);
    if (v !== undefined) present.push(v);
  }
  return shared(present, (v) => v, identity);
}

/** The label a field shows in place of a value the selection disagrees on. */
export const MIXED_LABEL = "Mixed";

// ---------------------------------------------------------------------------
// Edit-by-index list editing (Fork P-F1)
// ---------------------------------------------------------------------------

/**
 * The three per-node paint lists the inspector edits as rows.
 *
 * **Fork P-F1 is resolved here as edit-by-index** (the doc's recommendation)
 * rather than replace-all: the panel lists the *primary's* rows, and editing
 * row `i` writes to entry `i` of every selected node that has one. Selecting
 * three outlined shapes and dragging the first stroke's width therefore thickens
 * all three, while a node with fewer entries is skipped instead of having rows
 * invented for it. Replace-all would have destroyed per-node paint stacks on
 * every edit — a far more surprising outcome for an annotation tool.
 */
export type EntryList = "fills" | "strokes" | "effects";

export type EntryOf<K extends EntryList> = K extends "fills"
  ? Paint
  : K extends "strokes"
    ? Stroke
    : Effect;

/** Addresses one node's list entry — what the batch store actions take. */
export interface EntryRef {
  nodeId: string;
  entryId: string;
}

/** One selected node's entry at the row being edited. */
export interface EntryPeer<K extends EntryList> {
  nodeId: string;
  entry: EntryOf<K>;
}

/**
 * The entry at `index` of `key` on every node that has one — the batch target
 * for a row edit. Nodes with a shorter list are simply absent.
 */
export function entriesAt<K extends EntryList>(
  sel: readonly SceneNode[],
  key: K,
  index: number
): readonly EntryPeer<K>[] {
  const out: EntryPeer<K>[] = [];
  for (const node of sel) {
    // `node[key]` is Paint[] | Stroke[] | Effect[]; `K` picks which, but TS
    // can't relate the two through the conditional type, hence the hop.
    const entry = (node[key] as unknown as readonly EntryOf<K>[])[index];
    if (entry) out.push({ nodeId: node.id, entry });
  }
  return out;
}

/** Strip peers down to the `{nodeId, entryId}` pairs the store writes through. */
export function refsOf<K extends EntryList>(
  peers: readonly EntryPeer<K>[]
): readonly EntryRef[] {
  return peers.map((p) => ({ nodeId: p.nodeId, entryId: p.entry.id }));
}

/** `shared` over the peers at a row — the read half of edit-by-index. */
export function sharedEntry<K extends EntryList, T>(
  peers: readonly EntryPeer<K>[],
  pick: (entry: EntryOf<K>) => T,
  identity?: (value: T) => unknown
): Shared<T> | null {
  return shared(peers, (p) => pick(p.entry), identity);
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

/**
 * How a boolean property reads across the selection: all on, all off, or split.
 * A split toggle renders unpressed (and, for checkboxes, indeterminate) so it
 * never claims a state the selection doesn't have.
 */
export type TriState = "on" | "off" | "mixed";

export function triState<I>(
  items: readonly I[],
  pick: (item: I) => boolean
): TriState {
  const s = shared(items, pick);
  if (!s) return "off";
  if (s.mixed) return "mixed";
  return s.value ? "on" : "off";
}

/**
 * What a toggle click should write. A split selection resolves *on* — pressing
 * a mixed toggle unifies the selection rather than flipping each node
 * independently, so one press always produces a state you can see.
 */
export function toggleTarget(state: TriState): boolean {
  return state !== "on";
}
