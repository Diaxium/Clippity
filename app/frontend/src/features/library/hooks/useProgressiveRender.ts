import { useCallback, useEffect, useState } from "react";

/**
 * How many captures the grid mounts before the user has scrolled at all.
 *
 * Sized to overfill the tallest realistic first screen (a maximized
 * window with the rail and inspector closed fits well under this at the
 * 190px minimum card width), so the first paint is complete rather than
 * visibly filling in.
 */
export const INITIAL_RENDERED = 120;

/** How many more are mounted each time the sentinel comes into view. */
export const RENDER_STEP = 120;

/** Distance ahead of the viewport at which the next batch is mounted.
 *  Roughly two rows of cards — far enough that a normal scroll never
 *  reaches the end of the mounted list, close enough that a flick
 *  doesn't mount the whole library. */
const PREFETCH_MARGIN = "600px";

export interface UseProgressiveRenderResult {
  /** How many of the `total` captures to render right now. */
  count: number;
  /** Captures remain beyond `count` — the caller renders the sentinel. */
  hasMore: boolean;
  /** Ref for the sentinel element placed after the last rendered
   *  section. A callback ref, so mounting it is what arms the observer. */
  sentinelRef: (el: HTMLElement | null) => void;
}

/**
 * Grow the rendered slice of a long list as the user scrolls into it.
 *
 * The library shapes its whole listing up front — filtering, sorting and
 * day-grouping are cheap over an array — but *mounting* it is not: every
 * card is a motion component with a thumbnail observer, two store
 * subscriptions and a context menu, so a large library used to pay for
 * tens of thousands of them on first paint whether or not anything was
 * on screen. This bounds the mounted set to what has been scrolled to,
 * which is what keeps library first paint flat as the library grows
 * (performance roadmap P5).
 *
 * `resetKey` is the identity of the list being shown — change the scope,
 * the sort, the search or any filter and the budget starts over at the
 * top, because the user is now looking at a different list and the rows
 * they had scrolled past are not in it.
 *
 * Without `IntersectionObserver` (jsdom, and any environment that can't
 * report visibility) the whole list renders. Degrading to "mount
 * everything" keeps the grid correct — never silently truncated — and
 * leaves the pre-P5 behaviour exactly as it was.
 */
export function useProgressiveRender(
  total: number,
  resetKey: string,
  { initial = INITIAL_RENDERED, step = RENDER_STEP } = {},
): UseProgressiveRenderResult {
  const [budget, setBudget] = useState(initial);

  // The sentinel is held in state rather than a ref so that mounting it
  // re-runs the effect below — a plain ref's `.current` assignment
  // wouldn't, and the observer would never attach.
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const sentinelRef = useCallback((el: HTMLElement | null) => setSentinel(el), []);

  // A different list — start again from the top.
  useEffect(() => {
    setBudget(initial);
  }, [resetKey, initial]);

  const count = Math.min(budget, total);
  const hasMore = count < total;

  useEffect(() => {
    if (!sentinel || !hasMore) return;
    if (typeof IntersectionObserver === "undefined") {
      setBudget(total);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setBudget((b) => Math.min(b + step, total));
        }
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel, hasMore, step, total]);

  return { count, hasMore, sentinelRef };
}
