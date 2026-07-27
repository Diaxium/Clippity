/**
 * Typed IPC clients — one file per backend service domain.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * cross-feature IPC wrappers live here (not under
 * `features/<x>/services/`) so consumers can call into another
 * feature's backend service without reaching into that feature
 * folder. The wire-format types live alongside the wrappers.
 *
 * Adding a new client: create `<domain>.ts`, re-export here, and
 * cite the ADR follow-ups in FOLDER_STRUCTURE.md's decision table.
 */

export * from "./capture";
export * from "./overlay";
export * from "./toast";
export * from "./library";
export * from "./collections";
export * from "./editor";
export * from "./dashboard";
export * from "./models";
export * from "./share";
