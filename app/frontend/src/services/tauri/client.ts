import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";

import {
  beginIpcCall,
  endIpcCall,
  recordIpcSample,
} from "@shared/lib/ipcMetrics";
import { createLogger } from "@shared/lib/logger";

/** Every IPC call funnels through `invoke`, so this is the one place a
 *  failed command can be observed for free — no caller has to remember
 *  to log. The same property is what makes it the right place to time
 *  every call for the developer page's command inspector — see
 *  `recordIpcSample`, which is a no-op until that is armed. */
const log = createLogger("ipc");

/**
 * Wire-format error returned by every Rust command via
 * `infra::error::AppError::serialize`. Keeping the shape pinned here
 * (rather than `any`) means the UI can branch on `code` safely.
 */
export interface WireError {
  code: string;
  message: string;
}

export class TauriCommandError extends Error {
  readonly code: string;

  constructor(error: WireError) {
    super(error.message);
    this.name = "TauriCommandError";
    this.code = error.code;
  }
}

function isWireError(value: unknown): value is WireError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as WireError).code === "string"
  );
}

/**
 * Typed wrapper around `@tauri-apps/api`'s `invoke`. Use this in
 * preference to importing `invoke` directly so the rest of the app
 * has a single seam to mock in tests and a uniform error shape.
 *
 * @param command - Tauri command name (matches `#[tauri::command]` fn)
 * @param args    - Serializable payload (camelCase keys; Rust handlers
 *                  use `#[serde(rename_all = "camelCase")]`)
 */
export async function invoke<TResult, TArgs extends InvokeArgs = InvokeArgs>(
  command: string,
  args?: TArgs
): Promise<TResult> {
  // `performance.now()` rather than `Date.now()`: this measures a
  // sub-millisecond-resolution duration, not a point in time, and is
  // immune to the wall clock being adjusted mid-call.
  const started = performance.now();
  beginIpcCall();
  try {
    const result = await tauriInvoke<TResult>(command, args);
    endIpcCall();
    recordIpcSample({
      command,
      ms: performance.now() - started,
      ok: true,
      args,
      result,
    });
    return result;
  } catch (raw) {
    endIpcCall();
    recordIpcSample({
      command,
      ms: performance.now() - started,
      ok: false,
      code: isWireError(raw) ? raw.code : "bridge",
      args,
    });
    if (isWireError(raw)) {
      // Expected, handled failures (validation, unsupported mode, a
      // cancelled dialog). Debug-level so dev sees every failed command
      // without spamming production. Callers still branch on `.code`.
      log.debug(`command "${command}" failed`, {
        code: raw.code,
        message: raw.message,
      });
      throw new TauriCommandError(raw);
    }
    // Non-wire failure = the bridge itself misbehaved (down, serialization
    // bug, unexpected throw). That's genuinely unexpected — warn.
    log.warn(`command "${command}" threw a non-wire error`, raw);
    if (raw instanceof Error) throw raw;
    throw new Error(typeof raw === "string" ? raw : "Unknown Tauri error");
  }
}

/**
 * Returns true when the frontend is running inside a Tauri window
 * (vs. a plain browser preview). Useful for skipping IPC during
 * Storybook / Vitest runs.
 */
export function isTauriContext(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
