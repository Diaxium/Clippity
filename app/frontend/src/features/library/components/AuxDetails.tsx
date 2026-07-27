import { Check, Copy } from "lucide-react";

import { rgbToHsl } from "@shared/lib/paletteExport";
import { cn } from "@shared/lib/cn";

import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { textStats } from "../lib/format";
import type { AuxColor, CaptureMeta } from "../types";
import { PaletteCopyControl } from "./PaletteCopyControl";

/**
 * The details-pane body for an aux (non-file) entry — a color, a
 * palette, or a grabbed / pasted text run.
 *
 * These three kinds are the reason the inspector needs a per-kind body
 * at all. A screenshot's details are *facts about a file* and fit the
 * information table; an aux entry's details **are its content**, and the
 * content is the thing the user came here to take away. So each kind
 * gets the representations it is actually pasted in — a color as hex,
 * `rgb()` and `hsl()`; a palette as its swatches individually and as a
 * whole in six export formats; text as text, in full and scrollable
 * rather than clipped to the four lines a card can show.
 *
 * Every value on screen is one click from the clipboard, because for
 * these kinds "copy" is what "open in editor" is for a screenshot.
 */
export function AuxDetails({ meta }: { meta: CaptureMeta }) {
  if (meta.kind === "color" && meta.color) {
    return <ColorDetails color={meta.color} />;
  }
  if (meta.kind === "palette" && meta.palette?.length) {
    return <PaletteDetails palette={meta.palette} />;
  }
  if (meta.kind === "text" && meta.text) {
    return <TextDetails text={meta.text} />;
  }
  return null;
}

/** A sampled color in the three notations it gets pasted as. */
function ColorDetails({ color }: { color: AuxColor }) {
  const [h, s, l] = rgbToHsl(color.r, color.g, color.b);
  return (
    <>
      <SectionLabel>Value</SectionLabel>
      <div className="flex flex-col gap-1">
        <CopyRow label="HEX" value={color.hex.toUpperCase()} />
        <CopyRow label="RGB" value={`rgb(${color.r}, ${color.g}, ${color.b})`} />
        <CopyRow label="HSL" value={`hsl(${h}, ${s}%, ${l}%)`} />
      </div>
    </>
  );
}

/**
 * A palette, swatch by swatch and as a whole.
 *
 * The per-swatch rows exist because a palette is rarely used whole — the
 * common act is taking *one* color out of it — and the whole-palette
 * control keeps the six export formats (`PaletteCopyControl`) that the
 * card's action cluster used to carry.
 *
 * Rows are listed in the order the backend returns them, which is
 * dominant-first, so the color the region was mostly made of is the one
 * at the top.
 */
function PaletteDetails({ palette }: { palette: AuxColor[] }) {
  return (
    <>
      <div className="flex items-center justify-between pb-1 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-hint)]">
          Swatches
        </span>
        <PaletteCopyControl palette={palette} />
      </div>
      <div className="flex flex-col gap-1">
        {palette.map((c, i) => (
          <SwatchRow key={`${c.hex}:${i}`} color={c} />
        ))}
      </div>
    </>
  );
}

function SwatchRow({ color }: { color: AuxColor }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      onClick={() => void copy(color.hex)}
      title={`Copy ${color.hex}`}
      className="focus-ring flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left transition-colors hover:bg-[color:var(--color-overlay-1)]"
    >
      <span
        aria-hidden
        className="h-5 w-5 shrink-0 rounded-[6px]"
        style={{
          backgroundColor: color.hex,
          // Colors near the surface tint would otherwise vanish into it.
          boxShadow: "inset 0 0 0 1px var(--hairline-strong)",
        }}
      />
      <span className="flex-1 font-mono text-[11.5px] uppercase text-[var(--color-ink)]">
        {copied ? "Copied" : color.hex}
      </span>
      {color.proportion != null && (
        <span className="text-[11px] tabular-nums text-[var(--color-hint)]">
          {Math.round(color.proportion * 100)}%
        </span>
      )}
      <CopyGlyph copied={copied} />
    </button>
  );
}

/**
 * A text entry in full.
 *
 * Capped in height and scrolled rather than clipped: the card already
 * shows the first four lines, so a details pane that showed five would
 * add nothing. Rendered in the mono face because most of what lands here
 * is pasted code, a URL, or a log line, where the difference between
 * `l`, `1` and `I` is the point.
 */
function TextDetails({ text }: { text: string }) {
  const { copied, copy } = useCopyFeedback();
  const stats = textStats(text);
  return (
    <>
      <div className="flex items-center justify-between pb-1 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-hint)]">
          Text
        </span>
        <button
          type="button"
          onClick={() => void copy(text)}
          aria-label={copied ? "Text copied" : "Copy text"}
          title={copied ? "Copied" : "Copy text"}
          className="focus-ring grid h-6 w-6 place-items-center rounded-[7px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
        >
          <CopyGlyph copied={copied} />
        </button>
      </div>
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] p-2.5 font-mono text-[11.5px] leading-relaxed text-[var(--color-ink)]">
        {text}
      </pre>
      <p className="pt-1.5 text-[11px] text-[var(--color-hint)]">
        {stats.characters.toLocaleString()} characters ·{" "}
        {stats.words.toLocaleString()} words · {stats.lines.toLocaleString()}{" "}
        {stats.lines === 1 ? "line" : "lines"}
      </p>
    </>
  );
}

/** A labelled value with a copy button — the color notations. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      title={`Copy ${value}`}
      className="focus-ring flex h-8 items-center gap-2.5 rounded-[8px] px-1.5 text-left transition-colors hover:bg-[color:var(--color-overlay-1)]"
    >
      <span className="w-8 shrink-0 text-[11px] font-semibold text-[var(--color-hint)]">
        {label}
      </span>
      <span
        className={cn(
          "flex-1 truncate font-mono text-[11.5px] text-[var(--color-ink)]",
          copied && "text-[var(--color-accent)]"
        )}
      >
        {copied ? "Copied" : value}
      </span>
      <CopyGlyph copied={copied} />
    </button>
  );
}

function CopyGlyph({ copied }: { copied: boolean }) {
  return copied ? (
    <Check size={13} strokeWidth={2} className="text-[var(--color-accent)]" />
  ) : (
    <Copy size={13} strokeWidth={1.85} className="text-[var(--color-hint)]" />
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-hint)]">
      {children}
    </p>
  );
}
