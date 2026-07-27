/**
 * Grab-Text toast body — the recognized text (clipped to a few lines,
 * preserving OCR line breaks) plus a copied note. The text is already on
 * the clipboard; this toast is sticky (no auto-dismiss) so the user can
 * read it and dismiss via the chrome ×.
 */
export function TextToastBody({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1.5 pr-14">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
        Text grabbed · copied
      </span>
      <p className="line-clamp-5 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-[var(--color-ink)]">
        {text}
      </p>
    </div>
  );
}
