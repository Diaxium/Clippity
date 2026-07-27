/**
 * Share IPC client.
 *
 * "Share" here is the OS-level half of the
 * [sharing roadmap](../../../../docs/roadmaps/sharing-export.md): hand a
 * capture that is already on disk to something outside Clippity.
 * Nothing uploads and nothing leaves the machine — upload destinations
 * are a later phase behind the same `ShareTarget` union. The wire-format
 * types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::share::*` + `services::share_service::*`.
 */

import { invoke } from "@services/tauri";
import type { ShareTarget } from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::share`) ----------
export type { ShareTarget } from "@clippity/shared";

// ---------- IPC wrappers ----------

/** Hand the capture at `path` to `target`.
 *
 *  Rejects with a `share` error when the path isn't a file — a missing
 *  file is silent or confusing at the OS level (Explorer opens the wrong
 *  folder, the clipboard gets a path to nothing), so the backend fails
 *  loudly instead of pretending it worked. */
export function shareCapture(path: string, target: ShareTarget): Promise<void> {
  return invoke<void, { path: string; target: ShareTarget }>("share_capture", {
    path,
    target,
  });
}
