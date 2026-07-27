/**
 * Editor toolbar metadata. Pure data, no React — the top bar walks {@link
 * TOOL_MENU} to render grouped tool buttons + submenus, and the canvas
 * dispatches gesture handlers off the active `ToolId`.
 *
 * Organization note: Clippity's editor is a capture-*annotation* tool first, so
 * the toolbar leads with an "annotate" group (blur, pixelate, magnify, highlight,
 * step, callout — growing per roadmap Workstream A), with text and the vector
 * design tools (shapes, frame, pen) following. Figma's "comment"/plugin/scale
 * tools stay absent (no backing node type). Redaction was removed — it's just a
 * black-filled rectangle, so the rectangle + fill tools cover it (see ADR 0015).
 */

import {
  ArrowUpRight,
  BadgeCheck,
  Circle,
  Crop,
  Droplet,
  Focus,
  Frame,
  Grid2x2,
  Hand,
  Highlighter,
  Image as ImageIcon,
  ListOrdered,
  MessageSquare,
  MousePointer2,
  Pencil,
  PenTool,
  Ruler,
  Slash,
  Square,
  Star,
  Triangle,
  Type,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";

import type { ToolId } from "./types";

export interface ToolDef {
  id: ToolId;
  label: string;
  /** Single-key shortcut (display + binding); empty = no keyboard shortcut. */
  shortcut: string;
  Icon: LucideIcon;
  /** True when the tool creates a node by click-drag on the canvas. */
  draws: boolean;
}

export const TOOLS: readonly ToolDef[] = [
  {
    id: "select",
    label: "Move",
    shortcut: "V",
    Icon: MousePointer2,
    draws: false,
  },
  { id: "hand", label: "Hand tool", shortcut: "H", Icon: Hand, draws: false },
  // Crop opens a modal session over the page frame rather than drawing a node,
  // so `draws` is false and the canvas routes it before the drawing branch.
  { id: "crop", label: "Crop", shortcut: "C", Icon: Crop, draws: false },
  { id: "frame", label: "Frame", shortcut: "F", Icon: Frame, draws: true },
  {
    id: "rectangle",
    label: "Rectangle",
    shortcut: "R",
    Icon: Square,
    draws: true,
  },
  { id: "line", label: "Line", shortcut: "L", Icon: Slash, draws: true },
  {
    id: "arrow",
    label: "Arrow",
    shortcut: "A",
    Icon: ArrowUpRight,
    draws: true,
  },
  { id: "blur", label: "Blur", shortcut: "B", Icon: Droplet, draws: true },
  {
    id: "pixelate",
    label: "Pixelate",
    shortcut: "",
    Icon: Grid2x2,
    draws: true,
  },
  {
    id: "magnify",
    label: "Magnifier",
    shortcut: "",
    Icon: ZoomIn,
    draws: true,
  },
  {
    id: "highlight",
    label: "Highlight",
    shortcut: "",
    Icon: Highlighter,
    draws: true,
  },
  {
    id: "step",
    label: "Step",
    shortcut: "",
    Icon: ListOrdered,
    draws: true,
  },
  {
    id: "callout",
    label: "Callout",
    shortcut: "",
    Icon: MessageSquare,
    draws: true,
  },
  {
    id: "spotlight",
    label: "Spotlight",
    shortcut: "",
    Icon: Focus,
    draws: true,
  },
  // `M` was the one unbound letter in the map (docs/editor-keybinds.md) — and
  // Illustrator's `M` is its rectangle, which Clippity already binds to `R`.
  { id: "measure", label: "Measure", shortcut: "M", Icon: Ruler, draws: true },
  // No letter left to bind (the map is full since Measure took `M`), so stamps
  // join pixelate/magnify/step/callout/spotlight on the submenu only.
  { id: "stamp", label: "Stamp", shortcut: "", Icon: BadgeCheck, draws: true },
  { id: "ellipse", label: "Ellipse", shortcut: "O", Icon: Circle, draws: true },
  {
    id: "polygon",
    label: "Polygon",
    shortcut: "",
    Icon: Triangle,
    draws: true,
  },
  { id: "star", label: "Star", shortcut: "", Icon: Star, draws: true },
  {
    id: "image",
    label: "Image/video…",
    shortcut: "I",
    Icon: ImageIcon,
    draws: false,
  },
  { id: "text", label: "Text", shortcut: "T", Icon: Type, draws: true },
  { id: "pen", label: "Pen", shortcut: "P", Icon: PenTool, draws: false },
  { id: "pencil", label: "Pencil", shortcut: "", Icon: Pencil, draws: false },
] as const;

export const TOOL_BY_ID: Record<ToolId, ToolDef | undefined> =
  Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<
    ToolId,
    ToolDef | undefined
  >;

/** Single-key shortcut → tool id (tools without a shortcut are skipped). */
export const TOOL_SHORTCUTS: Record<string, ToolId> = Object.fromEntries(
  TOOLS.filter((t) => t.shortcut).map((t) => [t.shortcut.toLowerCase(), t.id])
);

/**
 * Toolbar layout: ordered groups. A multi-tool group renders a primary button
 * (showing its last-used sub-tool) plus a caret submenu; a single-tool group
 * renders a plain button. The first id in each group is its default primary.
 */
export interface ToolMenuGroup {
  id: string;
  toolIds: readonly ToolId[];
}

export const TOOL_MENU: readonly ToolMenuGroup[] = [
  { id: "pointer", toolIds: ["select", "hand"] },
  // Crop acts on the page, not on a selection, so it stands alone next to the
  // pointer group rather than joining the markup tools.
  { id: "crop", toolIds: ["crop"] },
  // Annotation-first: the markup group leads. Complete as of stamps — Workstream
  // A's tool list has no gap left.
  {
    id: "annotate",
    toolIds: [
      "blur",
      "pixelate",
      "magnify",
      "highlight",
      "step",
      "callout",
      "spotlight",
      "measure",
      "stamp",
    ],
  },
  { id: "text", toolIds: ["text"] },
  {
    id: "shape",
    toolIds: [
      "rectangle",
      "line",
      "arrow",
      "ellipse",
      "polygon",
      "star",
      "frame",
      "image",
    ],
  },
  { id: "pen", toolIds: ["pen", "pencil"] },
];

/** Tool id → the menu group it belongs to (for syncing the primary on keyboard
 *  tool changes). */
export const GROUP_OF: Partial<Record<ToolId, string>> = Object.fromEntries(
  TOOL_MENU.flatMap((g) => g.toolIds.map((id) => [id, g.id]))
);
