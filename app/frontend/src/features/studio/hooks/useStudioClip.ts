import { useEffect } from "react";

import { mediaProbe } from "@services/tauri/clients/media";

import { useStudioStore } from "../state/studioStore";

/**
 * Probe the capture `id` and put the result in the store.
 *
 * Probing is cheap regardless of the clip's length — the backend reads
 * the container's headers and stops — so this runs on every id change
 * without any caching layer between it and the command.
 *
 * Guards against the out-of-order resolve: switching clips quickly (or
 * a re-render racing a slow first probe) can land an older response
 * after a newer one, which would leave Studio describing one clip while
 * playing another. The cancelled flag drops anything that arrives for
 * an id the store has moved on from.
 */
export function useStudioClip(id: string | null): void {
  const open = useStudioStore((s) => s.open);
  const loaded = useStudioStore((s) => s.loaded);
  const failed = useStudioStore((s) => s.failed);
  const reset = useStudioStore((s) => s.reset);

  useEffect(() => {
    if (!id) {
      reset();
      return;
    }
    let cancelled = false;
    open(id);

    void mediaProbe(id)
      .then((info) => {
        if (!cancelled) loaded(info);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        failed(
          err instanceof Error
            ? err.message
            : "This recording could not be opened."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [id, open, loaded, failed, reset]);
}
