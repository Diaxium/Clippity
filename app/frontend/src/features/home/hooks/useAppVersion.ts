/**
 * The running app version for the Home "What's new" card.
 *
 * Reads it from the Tauri runtime (`@tauri-apps/api/app`). In a
 * browser-only preview the call rejects — we resolve to `null` and the
 * card hides the version line rather than showing a fake number.
 */

import { useEffect, useState } from "react";

import { getVersion } from "@tauri-apps/api/app";

export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        if (!cancelled) setVersion(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
