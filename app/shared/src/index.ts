/**
 * `@clippity/shared` — the single source of truth for the IPC wire-format
 * contracts exchanged between the React frontend and the Rust/Tauri backend.
 *
 * These types mirror the Rust `domain::*` structs (serde `camelCase`). The
 * frontend's `services/tauri/clients/*` re-export them so existing call sites
 * keep importing from the client modules unchanged, while the definitions live
 * in one shared, framework-agnostic place.
 */

export * from "./contracts/index";
