/**
 * Library measurement constants. Thumbnail widths are keyed into the
 * `useThumbnail` cache so grid + list variants don't collide.
 * Inherited from the legacy LibraryView.
 */

/** Grid-card thumbnail width (logical px). */
export const THUMBNAIL_GRID_W = 480;

/** List-row thumbnail width (logical px). */
export const THUMBNAIL_LIST_W = 120;

/** Smaller thumbnails in trash mode — the user is reviewing for
 *  delete/restore, not admiring detail. Matches legacy. */
export const THUMBNAIL_GRID_W_TRASH = 240;
export const THUMBNAIL_LIST_W_TRASH = 96;

/** Inspector-preview thumbnail width. Its own size (rather than reusing
 *  the grid's 480) so the preview stays crisp on a HiDPI display at the
 *  pane's ~288px content width, and so it shares a cache key with
 *  nothing else. */
export const THUMBNAIL_INSPECTOR_W = 640;

/** Width of the library's own destination rail and of the inspector.
 *  Fixed rather than fluid: both are lists of short labels, and letting
 *  them grow with the window steals the room the grid needs for another
 *  column. */
export const SIDEBAR_W = 232;
export const INSPECTOR_W = 320;
