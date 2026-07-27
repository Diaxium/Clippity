/**
 * Share wire-format contracts — mirror Rust `domain::share`.
 *
 * "Share" is the OS-level half of the sharing roadmap: hand a capture
 * that is already on disk to something outside Clippity. Nothing uploads.
 */

/** Where a saved capture should be handed off to.
 *
 *  - `reveal` — show it selected in the OS file manager.
 *  - `open` — open it with whatever the OS registered for the type.
 *  - `copy-path` — put the absolute path on the clipboard.
 */
export type ShareTarget = "reveal" | "open" | "copy-path";
