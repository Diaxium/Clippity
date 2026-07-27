export { invoke, isTauriContext, TauriCommandError } from "./client";
export type { WireError } from "./client";
export { on, EVENT_NAMES } from "./events";
export type { EventName } from "./events";

// Typed IPC clients — see ADR 0001. Each backend service domain has
// its own file under `./clients/`; wire types live alongside the
// wrappers.
export * from "./clients";
