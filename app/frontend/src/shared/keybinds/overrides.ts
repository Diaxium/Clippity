/**
 * User keybind overrides — the live bridge between the persisted
 * `settings.shortcuts.overrides` map and the in-app keybind registries
 * (editor / library / quick-capture).
 *
 * ### Why a module-level store, not a hook
 *
 * The registries build their dispatch indices from plain data at module
 * load; the resolve functions run inside a raw `window` `keydown` listener,
 * outside React's render cycle. A module-level, subscribable store lets
 * those pure indices rebuild when overrides change without threading React
 * state through every keystroke. {@link useSettings} pushes the current
 * map in via {@link setKeybindOverrides} whenever settings hydrate or
 * change — a one-way flow (settings store → this registry → registries),
 * mirrored in every window because every window mounts `Providers`.
 *
 * ### The override contract
 *
 * The map is keyed by fully-qualified binding id — `"<scope>:<id>"` — and
 * the value *replaces* that binding's registry-default combos:
 *
 * - id absent  → use the registry default.
 * - id present with a non-empty list → use exactly those combos.
 * - id present with an empty list → deliberately unbound (no combo fires).
 *
 * This mirrors the Rust `domain::settings::ShortcutsSettings.overrides`
 * shape 1:1, so the persisted JSON and the runtime behaviour never drift.
 */

/** Registry a binding belongs to — the `<scope>` half of a fully-qualified id. */
export type KeybindScope = "editor" | "library" | "quickCapture";

/** `fqid → replacement combos`. Matches the wire `overrides` map exactly. */
export type KeybindOverrides = Record<string, string[]>;

/** Build the fully-qualified id the overrides map is keyed by. */
export function fqid(scope: KeybindScope, id: string): string {
  return `${scope}:${id}`;
}

/**
 * The effective combos for a binding: its override if one is present
 * (including an explicit empty list = unbound), else the registry
 * `defaults`. The single resolution rule every registry and the settings
 * panel share.
 */
export function effectiveKeys(
  scope: KeybindScope,
  id: string,
  defaults: readonly string[],
  overrides: KeybindOverrides
): string[] {
  const override = overrides[fqid(scope, id)];
  return override !== undefined ? override : [...defaults];
}

/**
 * Return a copy of `bindings` with each binding's `keys` swapped for its
 * override, when one is present. Bindings without an override are returned
 * by reference (and the whole array is returned by reference when nothing
 * was overridden), so an unchanged overrides map costs no allocation and
 * lets callers cheaply skip an index rebuild.
 *
 * Note this only rewrites `keys` — it doesn't touch hand-authored
 * `helpKeys`. The editor clears those itself for overridden bindings (its
 * chips regenerate from the new combo); library / quick-capture carry no
 * `helpKeys`, so the generic form is exactly right for them.
 */
export function applyOverrides<T extends { id: string; keys: string[] }>(
  scope: KeybindScope,
  bindings: readonly T[],
  overrides: KeybindOverrides
): readonly T[] {
  let changed = false;
  const out = bindings.map((binding) => {
    const override = overrides[fqid(scope, binding.id)];
    if (override === undefined) return binding;
    changed = true;
    return { ...binding, keys: [...override] };
  });
  return changed ? out : bindings;
}

// ---------- Live module-level store ----------

let current: KeybindOverrides = {};
let version = 0;
const listeners = new Set<() => void>();

/** The overrides currently in effect (may be empty). Readers should pair
 *  this with {@link keybindOverridesVersion} to memoize derived indices. */
export function getKeybindOverrides(): KeybindOverrides {
  return current;
}

/** Monotonic counter bumped on every {@link setKeybindOverrides}. Registries
 *  compare it against a cached value to know when to rebuild their index. */
export function keybindOverridesVersion(): number {
  return version;
}

/**
 * Replace the live overrides map and notify subscribers. Called by
 * {@link useSettings} from the hydrated `settings.shortcuts.overrides`.
 * A no-op (no version bump, no notify) when the map is value-equal to the
 * current one, so an unrelated settings change doesn't needlessly rebuild
 * every keybind index.
 */
export function setKeybindOverrides(next: KeybindOverrides | undefined): void {
  const value = next ?? {};
  if (overridesEqual(current, value)) return;
  current = value;
  version += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to override changes (returns an unsubscribe). React callers
 *  can feed this to `useSyncExternalStore`; the registries use it to trigger
 *  a listener re-bind. */
export function subscribeKeybindOverrides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shallow value-equality over the `fqid → combos` map. */
function overridesEqual(a: KeybindOverrides, b: KeybindOverrides): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    const av = a[key];
    const bv = b[key];
    if (!bv || av === undefined || av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i += 1) {
      if (av[i] !== bv[i]) return false;
    }
  }
  return true;
}

/** Test-only reset so a suite can start from a clean override map. */
export function __resetKeybindOverridesForTest(): void {
  current = {};
  version = 0;
  listeners.clear();
}
