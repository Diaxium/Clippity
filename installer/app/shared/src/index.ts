/**
 * `@clippity/installer-shared` — the single source of truth for the IPC
 * wire-format contracts exchanged between the React wizard frontend and
 * the Rust/Tauri backend.
 *
 * These types mirror the Rust `installer_domain::*` structs (serde
 * `camelCase`). Keeping them framework-agnostic means the same shapes
 * describe a component list, an install plan, or a progress event whether
 * they're rendered by React or produced by the Rust services.
 */

export * from "./contracts/index";
