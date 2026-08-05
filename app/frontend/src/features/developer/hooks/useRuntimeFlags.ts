/**
 * The facts that override what settings say — safe mode, a log level
 * pinned by an environment variable, whether this build carries the
 * WebView inspector.
 *
 * Fetched once per mount and never refreshed: all three are fixed for
 * the life of the process, and a page that re-asked would be implying
 * they could change under it.
 */

import { useEffect, useState } from "react";

import {
  getRuntimeFlags,
  type RuntimeFlags,
} from "@services/tauri/clients/developer";

export function useRuntimeFlags(): RuntimeFlags | null {
  const [flags, setFlags] = useState<RuntimeFlags | null>(null);

  useEffect(() => {
    let alive = true;
    void getRuntimeFlags().then(
      (next) => {
        if (alive) setFlags(next);
      },
      () => {
        // Outside Tauri (browser preview, tests) there is nothing to
        // ask. The page renders as though nothing is overridden, which
        // is the honest answer when there is no process to describe.
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  return flags;
}
