/**
 * Lazy + cached thumbnail loader. Ported from the legacy
 * `lib/useThumbnail.ts` — same three guarantees:
 *
 * - **Cache survives navigation.** A module-level `Map` keyed by
 *   `(id, maxWidth)` means switching grid↔list or refreshing after a
 *   delete doesn't re-decode through Tauri.
 * - **Concurrent fetches join.** Two cards requesting the same
 *   `(id, maxWidth)` share one in-flight promise.
 * - **Off-screen defers.** An `IntersectionObserver` (rootMargin
 *   200px) holds the fetch until the card scrolls into view.
 *
 * The cache is module-level (persists for the app session) and bounded
 * by a small LRU cap: each entry holds a base64 data URI (tens to a few
 * hundred KB), so an unbounded map would let idle RAM climb without limit
 * as the user scrolls a large library — memory that's never reclaimed even
 * after the dashboard window is hidden to the tray. `cacheGet`/`cacheSet`
 * keep the most-recently-used `CACHE_LIMIT` entries and evict the rest; a
 * re-scroll past an evicted capture just re-decodes through Tauri.
 */

import { useEffect, useState, type RefObject } from "react";

import { libraryThumbnail } from "@services/tauri/clients/library";

type Key = string;

/** Max decoded thumbnails kept in memory. ~160 covers several screens of
 *  grid + list tiles; past that the oldest are evicted so idle RAM stays
 *  bounded regardless of library size. */
const CACHE_LIMIT = 160;

// Insertion-ordered Map used as an LRU: `cacheGet` re-inserts on hit to
// mark an entry most-recent, `cacheSet` evicts from the front (oldest)
// once the cap is exceeded.
const cache = new Map<Key, string>();
const inflight = new Map<Key, Promise<string | null>>();

const keyOf = (id: string, maxWidth: number): Key => `${id}::${maxWidth}`;

/** LRU read: returns the cached URI (if any) and bumps it to most-recent. */
function cacheGet(key: Key): string | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** LRU write: store as most-recent, then evict the oldest over the cap. */
function cacheSet(key: Key, value: string): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as Key | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Run the fetch (or join an in-flight one) + populate the cache. */
function fetchThumbnail(id: string, maxWidth: number): Promise<string | null> {
  const key = keyOf(id, maxWidth);
  const cached = cacheGet(key);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = libraryThumbnail(id, maxWidth)
    .then((uri) => {
      inflight.delete(key);
      if (uri) {
        cacheSet(key, uri);
        return uri;
      }
      return null;
    })
    .catch(() => {
      // A failed decode shouldn't wedge the in-flight slot — drop it
      // so a later attempt can retry.
      inflight.delete(key);
      return null;
    });
  inflight.set(key, p);
  return p;
}

/**
 * @param ref      Element to observe for visibility (the card
 *                 wrapper). Pass `null` to fetch eagerly (e.g. a
 *                 component that's always on-screen).
 * @param id       Capture id (= absolute file path).
 * @param maxWidth Logical-pixel width; keyed into the cache so grid
 *                 (480) and list (120) thumbnails don't collide.
 */
export function useThumbnail(
  ref: RefObject<HTMLElement | null> | null,
  id: string | null,
  maxWidth: number
): string | null {
  const key = id ? keyOf(id, maxWidth) : "";
  const [src, setSrc] = useState<string | null>(() => cacheGet(key) ?? null);

  useEffect(() => {
    // Aux entries (color / palette / text) have no file to decode — the
    // card renders a swatch instead and passes a null id here.
    if (!id) {
      setSrc(null);
      return;
    }
    const fetchId = id;
    const hit = cacheGet(key);
    if (hit !== undefined) {
      setSrc(hit);
      return;
    }

    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      void fetchThumbnail(fetchId, maxWidth).then((uri) => {
        if (!cancelled && uri) setSrc(uri);
      });
    };

    // No ref (or no IntersectionObserver) → fetch immediately.
    if (!ref?.current || typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        cancelled = true;
      };
    }

    const target = ref.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            io.disconnect();
            start();
            break;
          }
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(target);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [ref, id, maxWidth, key]);

  return src;
}

/** Test-only: clear the module-level caches so each test starts
 *  fresh. Not part of the public hook surface. */
export function __resetThumbnailCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/** Test-only: current number of cached thumbnails, to assert the LRU cap
 *  holds. Not part of the public hook surface. */
export function __thumbnailCacheSizeForTests(): number {
  return cache.size;
}
