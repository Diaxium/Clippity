/**
 * Feature-flag registry — the switches Settings → Advanced can override.
 *
 * **Every flag in this catalogue has a real consumer.** A flag table
 * listing switches nothing reads is a lie the settings page tells on the
 * app's behalf, so the list is short by design and grows when a
 * consumer does. Each entry names where it is read, and the backend ids
 * are duplicated as constants in `services::settings_service` — the two
 * must not drift.
 *
 * Resolution is `override ?? build default`, so a user who has never
 * opened the page gets exactly the shipped behaviour, and an override
 * for a flag that no longer exists is ignored rather than resurrecting
 * a code path that has gone.
 */

/** Where a flag is read, which decides how a change takes effect. */
export type FlagConsumer = "backend" | "frontend";

export interface FeatureFlagDef {
  id: string;
  label: string;
  /** What turning it off actually does — written for the person
   *  debugging, not for a marketing page. */
  description: string;
  /** The shipped behaviour. Every flag here defaults on: they gate
   *  paths that are the *better* option when they work, and exist so a
   *  user can fall back when they don't. */
  defaultOn: boolean;
  consumer: FlagConsumer;
  /** Whether the change only lands after a restart. */
  restartRequired: boolean;
}

/**
 * The catalogue. Ids are dotted `<area>.<thing>` and are persisted, so
 * renaming one silently drops every user's override for it.
 */
export const FEATURE_FLAGS: readonly FeatureFlagDef[] = [
  {
    id: "capture.hdr",
    label: "HDR capture path",
    description:
      "Grab HDR displays in scRGB and tone-map them. Off falls back to the ordinary 8-bit grab — the comparison to make when a shot off an HDR display looks wrong.",
    defaultOn: true,
    consumer: "backend",
    restartRequired: false,
  },
  {
    id: "recorder.duplication",
    label: "Desktop Duplication recording",
    description:
      "Hold one duplication of the output for the length of a recording. Off uses per-call grabs — slower, but the path to try when a recording tears, stalls, or comes back black.",
    defaultOn: true,
    consumer: "backend",
    restartRequired: false,
  },
] as const;

/** The resolved state of one flag, and why it is in that state. */
export interface ResolvedFlag {
  def: FeatureFlagDef;
  enabled: boolean;
  /** `default` = the build's answer; `override` = this user's. */
  source: "default" | "override";
}

/** Overrides as persisted on `developer.featureFlags`. */
export type FlagOverrides = Record<string, boolean>;

let overrides: FlagOverrides = {};

/**
 * Mirror the persisted overrides into the module registry. Called from
 * `Providers` on every settings change, the same way keybind overrides
 * are — so `isFeatureEnabled` can stay a plain function that any module
 * can call without a hook or a store subscription.
 */
export function setFeatureFlagOverrides(next: FlagOverrides | undefined): void {
  overrides = next ?? {};
}

/** The overrides currently in force. */
export function featureFlagOverrides(): FlagOverrides {
  return overrides;
}

/** Pure: resolve one definition against a set of overrides. */
export function resolveFlag(
  def: FeatureFlagDef,
  from: FlagOverrides = overrides
): ResolvedFlag {
  const override = from[def.id];
  return typeof override === "boolean"
    ? { def, enabled: override, source: "override" }
    : { def, enabled: def.defaultOn, source: "default" };
}

/** Pure: resolve the whole catalogue. */
export function resolveFlags(from: FlagOverrides = overrides): ResolvedFlag[] {
  return FEATURE_FLAGS.map((def) => resolveFlag(def, from));
}

/**
 * Whether `id` is on. An unknown id is `false` — a caller asking about
 * a flag that isn't in the catalogue is asking about a code path that
 * doesn't exist, and answering "on" would be the dangerous direction to
 * guess in.
 */
export function isFeatureEnabled(id: string): boolean {
  const def = FEATURE_FLAGS.find((f) => f.id === id);
  if (!def) return false;
  return resolveFlag(def).enabled;
}

/**
 * Pure: the override map after setting `id` to `state`.
 *
 * `"default"` *removes* the entry rather than writing the shipped
 * value, so a user who resets a flag keeps following the build if the
 * default later changes — which is the difference between "I don't have
 * an opinion" and "I want it on".
 */
export function withOverride(
  from: FlagOverrides,
  id: string,
  state: boolean | "default"
): FlagOverrides {
  const next = { ...from };
  if (state === "default") {
    delete next[id];
  } else {
    next[id] = state;
  }
  return next;
}

/**
 * Pure: drop overrides for flags that are no longer in the catalogue.
 *
 * Applied when the page loads the persisted map, so a settings file
 * written by an older build doesn't carry dead ids forever — and so the
 * "N overrides" count in the UI matches what the table shows.
 */
export function pruneOverrides(from: FlagOverrides): FlagOverrides {
  const known = new Set(FEATURE_FLAGS.map((f) => f.id));
  const next: FlagOverrides = {};
  for (const [id, value] of Object.entries(from)) {
    if (known.has(id)) next[id] = value;
  }
  return next;
}

/** Pure: a copyable summary of what is in force, for a bug report. */
export function formatFlags(from: FlagOverrides = overrides): string {
  return resolveFlags(from)
    .map(
      ({ def, enabled, source }) =>
        `${def.id} = ${enabled ? "on" : "off"} (${source})`
    )
    .join("\n");
}
