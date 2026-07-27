/**
 * The recording-area outline (ADR 0031).
 *
 * A transparent, click-through, always-on-top window the backend sizes
 * to the recorded region (grown by `domain::recorder::OUTLINE_PX` so
 * the ring frames the pixels rather than covering their edge). This
 * component draws only the ring — the interior must stay fully
 * transparent, because the thing behind it is what the user is
 * recording and working in.
 *
 * Deliberately static: no state, no IPC, no listeners. Everything that
 * varies — where it is, how big, whether it exists at all — is decided
 * backend-side by the session. A window that redrew itself would be a
 * window that could flicker over a recording.
 */
export function RecorderFrameWindow() {
  return (
    <div
      aria-hidden
      className="pointer-events-none h-screen w-screen"
      style={{
        // Inset so the ring is drawn *inside* the window bounds, which
        // the backend already grew outward to make room for it.
        border: "3px solid var(--color-accent)",
        // A soft outer glow lifts the ring off busy content — a flat
        // line disappears against a window border of a similar colour.
        boxShadow:
          "0 0 0 1px rgba(0,0,0,.35), 0 0 12px color-mix(in srgb, var(--color-accent) 55%, transparent)",
        borderRadius: 2,
      }}
    />
  );
}
