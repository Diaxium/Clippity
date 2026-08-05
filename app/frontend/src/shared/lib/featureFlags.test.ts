import { beforeEach, describe, expect, it } from "vitest";

import {
  FEATURE_FLAGS,
  formatFlags,
  isFeatureEnabled,
  pruneOverrides,
  resolveFlag,
  resolveFlags,
  setFeatureFlagOverrides,
  withOverride,
} from "./featureFlags";

const FIRST = FEATURE_FLAGS[0]!;

describe("feature flags", () => {
  beforeEach(() => setFeatureFlagOverrides({}));

  it("every catalogued flag names where it is read", () => {
    // A flag with no consumer is a lie the settings page tells on the
    // app's behalf. The registry is short on purpose.
    for (const flag of FEATURE_FLAGS) {
      expect(flag.id).toMatch(/^[a-z]+\.[a-z-]+$/);
      expect(["backend", "frontend"]).toContain(flag.consumer);
      expect(flag.description.length).toBeGreaterThan(20);
    }
  });

  it("resolves to the build default when there is no override", () => {
    const resolved = resolveFlag(FIRST, {});
    expect(resolved.enabled).toBe(FIRST.defaultOn);
    expect(resolved.source).toBe("default");
  });

  it("an override wins over the default", () => {
    const resolved = resolveFlag(FIRST, { [FIRST.id]: !FIRST.defaultOn });
    expect(resolved.enabled).toBe(!FIRST.defaultOn);
    expect(resolved.source).toBe("override");
  });

  it("resetting a flag removes the entry rather than writing the default", () => {
    // "I have no opinion" and "I want it on" are different states: only
    // the first should follow the build if the default later changes.
    const set = withOverride({}, FIRST.id, false);
    expect(set[FIRST.id]).toBe(false);
    const reset = withOverride(set, FIRST.id, "default");
    expect(FIRST.id in reset).toBe(false);
  });

  it("an unknown flag is off, not on", () => {
    // A caller asking about a flag that isn't catalogued is asking about
    // a code path that doesn't exist — "on" is the dangerous guess.
    expect(isFeatureEnabled("nope.missing")).toBe(false);
  });

  it("reads through the module registry once overrides are installed", () => {
    setFeatureFlagOverrides({ [FIRST.id]: !FIRST.defaultOn });
    expect(isFeatureEnabled(FIRST.id)).toBe(!FIRST.defaultOn);
    setFeatureFlagOverrides(undefined);
    expect(isFeatureEnabled(FIRST.id)).toBe(FIRST.defaultOn);
  });

  it("drops overrides for flags that no longer exist", () => {
    // A settings file from an older build must not carry dead ids
    // forever, or the "N overrides" count stops matching the table.
    const pruned = pruneOverrides({
      [FIRST.id]: false,
      "gone.flag": true,
    });
    expect(pruned).toEqual({ [FIRST.id]: false });
  });

  it("formats a copyable summary naming the source of each state", () => {
    const text = formatFlags({ [FIRST.id]: false });
    expect(text).toContain(`${FIRST.id} = off (override)`);
    expect(resolveFlags({ [FIRST.id]: false })).toHaveLength(
      FEATURE_FLAGS.length
    );
  });
});
