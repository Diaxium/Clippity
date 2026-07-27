/**
 * Control chrome shared by the inspector's form fields.
 *
 * `NumberField` bakes its own copy of this into its container; everything that
 * isn't a NumberField — chiefly the shared `Select`, which is styled by the
 * caller through `triggerClassName` — reads it from here. Before this existed
 * the same class string was pasted at seven call sites, so a field height or
 * radius change silently reached only the ones that got edited.
 */

/** A `Select` trigger sized and filled to match `NumberField`. Width is left to
 *  the call site (`w-full` in a column, a fixed width beside a row label). */
export const SELECT_TRIGGER =
  "h-8 rounded-[8px] border border-[color:var(--ed-control-hairline)] bg-[var(--ed-input-bg)] px-2.5 text-[12px] text-[var(--ed-text)]";

/** The common case: a trigger filling its column. */
export const SELECT_TRIGGER_FULL = `${SELECT_TRIGGER} w-full`;
