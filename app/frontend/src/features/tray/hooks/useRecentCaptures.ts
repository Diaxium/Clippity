/**
 * Recent-captures controller for the tray panel.
 *
 * Pulls the newest image captures from the library service and resolves
 * a thumbnail for each. Re-fetches when the panel opens
 * (`clippity://tray/opened`) and whenever the captures dir changes
 * (`clippity://library/updated`) so a fresh grab shows up immediately.
 *
 * **Favorites come first.** A four-tile strip is the tray's whole view
 * of the library, and a starred capture is the user saying "this is the
 * one I keep coming back to" — which outranks recency in a quick-access
 * surface. Within each group the order is still newest-first, so the
 * strip never stops behaving like "recent" for anyone who stars nothing.
 *
 * Reuses the shared library IPC client (no `features/library` import —
 * that boundary is forbidden). Titles render first; thumbnails stream in
 * as their data URIs decode.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { isTauriContext } from "@services/tauri";
import {
  libraryList,
  libraryThumbnail,
  onLibraryUpdated,
  type CaptureMeta,
} from "@services/tauri/clients/library";
import { onTrayOpened } from "@services/tauri/clients/tray";
import { createLogger } from "@shared/lib/logger";

import type { RecentCapture } from "../types";

const log = createLogger("tray");

/** How many recent captures the strip shows. */
const RECENT_LIMIT = 4;
/** Thumbnail decode width — ~2× the displayed tile for crispness. */
const THUMB_WIDTH = 132;

/**
 * The image captures the strip shows: favorites first, then the rest,
 * each group newest-first. Pure — exported for tests.
 *
 * The listing already arrives newest-first, so this only has to be a
 * stable partition; it deliberately does not re-sort by time, which
 * would undo the backend's tie-break on id.
 */
export function pickRecents(all: CaptureMeta[]): CaptureMeta[] {
  const images = all.filter((c) => c.kind === "image");
  return [
    ...images.filter((c) => c.favorite === true),
    ...images.filter((c) => c.favorite !== true),
  ].slice(0, RECENT_LIMIT);
}

export function useRecentCaptures() {
  const [recents, setRecents] = useState<RecentCapture[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  // Bumped each fetch so a slow response can't overwrite a newer one.
  const reqIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!isTauriContext()) return;
    const reqId = ++reqIdRef.current;
    const fresh = () => mountedRef.current && reqId === reqIdRef.current;

    setLoading(true);
    try {
      const all = await libraryList(false);
      const top = pickRecents(all);
      if (!fresh()) return;
      // Show titles immediately; thumbs fill in once decoded.
      setRecents(top.map((c) => ({ id: c.id, title: c.title, thumb: null })));

      const thumbs = await Promise.all(
        top.map((c) => libraryThumbnail(c.id, THUMB_WIDTH).catch(() => null))
      );
      if (!fresh()) return;
      setRecents(
        top.map((c, i) => ({
          id: c.id,
          title: c.title,
          thumb: thumbs[i] ?? null,
        }))
      );
    } catch (err) {
      log.warn("failed to load recent captures", err);
      if (fresh()) setRecents([]);
    } finally {
      if (fresh()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => onTrayOpened(() => void refresh()), [refresh]);
  useEffect(() => onLibraryUpdated(() => void refresh()), [refresh]);

  return { recents, loading };
}
