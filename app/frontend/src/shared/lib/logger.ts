/**
 * Minimal structured logger — the single sanctioned console boundary
 * for the frontend.
 *
 * Why this exists: before it, the app logged *nothing*. Caught errors
 * were reduced to a user-facing toast message and the developer-facing
 * detail (error `code`, stack, the failing command) was discarded.
 * Routing every diagnostic through one place lets it be module-tagged,
 * level-filtered, redacted, and — later — forwarded to the backend
 * `tracing` log so frontend + backend share one timeline.
 *
 * Levels & gating:
 *   - `debug` / `info`  developer flow. Emitted only in dev builds.
 *   - `warn` / `error`  problems. Emitted in dev *and* production.
 *   - Under `vitest` (`MODE === "test"`) everything is silent by
 *     default so the suite stays quiet; flip with `setLoggerEnabled`.
 *
 * Usage:
 *   const log = createLogger("capture");
 *   log.warn("library refresh failed", err);
 *   log.debug("snapshot decoded", { width, height });
 */

/* eslint-disable no-console -- this module is the ONE place the app is
   allowed to touch the console; every other file routes through it, which
   is what keeps the `no-console` rule meaningful everywhere else. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const isTest = import.meta.env.MODE === "test";
const isDev = import.meta.env.DEV;

// Production keeps warn/error but drops the verbose levels; dev keeps
// everything. The threshold is fixed at module load — the build mode
// can't change at runtime.
const minRank = isDev ? LEVEL_RANK.debug : LEVEL_RANK.warn;

// Silent in the test runner by default so the suite isn't spammed (and
// so console.error-based test tooling doesn't trip on intentional error
// logs). A test that wants to assert logging flips this on.
let enabled = !isTest;

/**
 * Test seam — enable or silence emission. No effect on the dev/prod
 * level threshold; it only gates whether anything is written at all.
 */
export function setLoggerEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Keys whose values are masked before a context object is logged.
 * Defense-in-depth: the frontend rarely logs secrets, but a stray token
 * inside an error payload or IPC argument shouldn't leak to the console.
 */
const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[-_]?key|authorization|cookie|session)/i;

/**
 * Recursively mask sensitive *values* by key name. Primitives pass
 * through; `Error`s are summarized to `{ name, message, code? }` (never
 * a raw stack here); depth is bounded so a cyclic-ish object can't spin.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value;
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return code === undefined
      ? { name: value.name, message: value.message }
      : { name: value.name, message: value.message, code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** `[clippity:capture]` — the greppable, module-tagged line prefix. */
export function formatPrefix(module: string): string {
  return `[clippity:${module}]`;
}

function emit(
  level: LogLevel,
  module: string,
  message: string,
  context?: unknown
): void {
  if (!enabled || LEVEL_RANK[level] < minRank) return;
  const prefix = formatPrefix(module);
  if (context === undefined) {
    console[level](prefix, message);
  } else {
    console[level](prefix, message, redact(context));
  }
}

/**
 * Build a logger bound to a `module` tag (typically the feature or
 * subsystem name, e.g. `"capture"`, `"ipc"`, `"overlay"`).
 */
export function createLogger(module: string): Logger {
  return {
    debug: (message, context) => emit("debug", module, message, context),
    info: (message, context) => emit("info", module, message, context),
    warn: (message, context) => emit("warn", module, message, context),
    error: (message, context) => emit("error", module, message, context),
  };
}

/** App-wide default logger, for code without a more specific module. */
export const logger = createLogger("app");
