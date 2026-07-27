import { useCallback, useEffect } from "react";

import {
  desktopSnapshotUrl,
  getDesktopSnapshotId,
  onOverlayOpening,
  onOverlayShown,
  onOverlaySnapshotReady,
} from "@services/tauri/clients/overlay";

import { useOverlayStore } from "../state/overlayStore";

/**
 * Points the overlay at the pre-overlay desktop snapshot: resolves its
 * URL, decodes it off the main thread via `createImageBitmap`, and draws
 * it onto a hidden canvas so the loupe / RGB HUD can sample pixels via
 * `getImageData`.
 *
 * The snapshot arrives as a URL on the `clippity-snapshot` scheme rather
 * than as a base64 data URI. At 1920×1200 the desktop PNG is ~8 MiB; as
 * a data URI that was an 11 MiB string crossing the JSON IPC bridge, an
 * `atob` of it on the main thread, and then a *separate* decode for each
 * of the three places the overlay paints it (backdrop, magnifier, small
 * preview). A URL costs one fetch and one decode that all three share.
 *
 * Backend timing: PNG encoding runs on a background thread (see
 * `overlay_service::show`), so the bytes may not be servable when
 * `OVERLAY_SHOWN` fires. We listen for the dedicated
 * `OVERLAY_SNAPSHOT_READY` event for the late case, and still attempt
 * a load on `SHOWN` for the fast-path case (small monitors where the
 * encode finishes before the show event reaches us). Best-effort —
 * failures are swallowed (the loupe just won't render until the next
 * successful fetch).
 */
export function useOverlaySnapshot() {
  const setSnapshot = useOverlayStore((s) => s.setSnapshot);
  const setMode = useOverlayStore((s) => s.setMode);
  const reset = useOverlayStore((s) => s.reset);

  const load = useCallback(async () => {
    try {
      const id = await getDesktopSnapshotId();
      if (id === null) return;
      const url = desktopSnapshotUrl(id);
      // `show` fires both OVERLAY_SHOWN (with `snapshotOk`) and, slightly
      // later, OVERLAY_SNAPSHOT_READY — on a fast monitor both can resolve a
      // `load()` against the same snapshot. Skip the re-decode when the store
      // already holds exactly this one.
      if (useOverlayStore.getState().snapshot.url === url) return;
      await loadIntoCanvas(url, setSnapshot);
    } catch {
      /* swallow — see hook doc comment */
    }
  }, [setSnapshot]);

  // Initial load on mount.
  useEffect(() => {
    void load();
  }, [load]);

  // Reset before the reused overlay window becomes visible.
  useEffect(() => {
    return onOverlayOpening((payload) => {
      setMode(payload.mode);
      reset(toLogicalPoint(payload.cursorPosition));
    });
  }, [reset, setMode]);

  // SHOWN fires immediately after the overlay window appears — the
  // snapshot might already be ready (fast path) or might still be
  // encoding. Attempt a load either way; the backend returns null
  // until the encoder thread lands the URI, and SNAPSHOT_READY below
  // handles the late case.
  useEffect(() => {
    return onOverlayShown((payload) => {
      setMode(payload.mode);
      if (payload.snapshotOk) void load();
    });
  }, [load, setMode]);

  // Late-path: the background encoder finished after SHOWN already
  // fired. Fetch + populate now so the magnifier becomes usable.
  useEffect(() => {
    return onOverlaySnapshotReady(() => {
      void load();
    });
  }, [load]);
}

function toLogicalPoint(position: [number, number] | null) {
  if (!position) return null;
  const dpr = window.devicePixelRatio || 1;
  return { x: position[0] / dpr, y: position[1] / dpr };
}

/**
 * Fetch the snapshot and draw it into a 2D canvas configured for
 * frequent reads, so the loupe can `getImageData` a pixel per pointer
 * move.
 *
 * `fetch` + `blob()` keeps the bytes native the whole way — they are
 * never a JS string, which is what the base64 data URI forced (an `atob`
 * of ~11 MiB plus a typed-array copy, on the main thread, before the
 * decode could even start). `createImageBitmap` then decodes off-thread
 * and `drawImage` is a single GPU blit.
 *
 * The same URL is handed to the store, so the CSS `url(…)` consumers
 * resolve to the response the webview has already cached rather than
 * decoding their own copy.
 */
async function loadIntoCanvas(
  url: string,
  setSnapshot: ReturnType<typeof useOverlayStore.getState>["setSnapshot"]
): Promise<void> {
  let bitmap: ImageBitmap | null = null;
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    bitmap = await createImageBitmap(await response.blob());
  } catch {
    return;
  }
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  setSnapshot({ url, sampleCtx: ctx });
}
