import { useEffect, useRef, useState } from "react";
import type { ComponentType, MouseEvent, ReactNode, Ref } from "react";

import {
  Baseline,
  CalendarDays,
  CalendarRange,
  Check,
  Clapperboard,
  Droplet,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Images,
  Layers,
  Palette,
  Pencil,
  Plus,
  Star,
  TagsIcon,
  Trash2,
  X,
} from "lucide-react";

import {
  collectionsCreate,
  collectionsRemove,
  collectionsRename,
} from "@services/tauri/clients/collections";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { cn } from "@shared/lib/cn";

import { SIDEBAR_W } from "../constants";
import { SMART_COLLECTIONS } from "../lib/smart";
import { sameScope } from "../state/libraryStore";
import type {
  CaptureKind,
  Collection,
  LibraryFacets,
  LibraryScope,
  SmartId,
} from "../types";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

/** Sidebar row icon per capture kind. */
const KIND_ICON: Record<CaptureKind, Icon> = {
  image: ImageIcon,
  video: Clapperboard,
  gif: Images,
  color: Droplet,
  palette: Palette,
  text: Baseline,
};

/** Sidebar row label per capture kind — plural, because every row is a
 *  set rather than a single capture. */
const KIND_LABEL: Record<CaptureKind, string> = {
  image: "Screenshots",
  video: "Videos",
  gif: "GIFs",
  color: "Colors",
  palette: "Palettes",
  text: "Text",
};

/**
 * Kind rows, in display order.
 *
 * All six are offered at all times, including at zero. The library holds
 * two families — files (screenshots, recordings, GIFs) and aux entries
 * (a sampled color, an extracted palette, a run of grabbed or pasted
 * text) — and the aux half is the half a user is least likely to know
 * exists. Hiding those rows until something lands in them means the only
 * way to discover that Clippity keeps your colors is to have already
 * sampled one, so an empty "Palettes" earns its line: it reads as "you
 * haven't extracted one yet", not as a feature that isn't there.
 */
const KIND_ORDER: readonly CaptureKind[] = [
  "image",
  "video",
  "gif",
  "color",
  "palette",
  "text",
];

const SMART_ICON: Record<SmartId, Icon> = {
  "this-week": CalendarDays,
  "last-30-days": CalendarRange,
  large: HardDrive,
  untagged: TagsIcon,
};

/** Which aggregated count sizes each smart collection. The rule itself
 *  still lives in `matchesSmart` — this only says which pre-counted
 *  number corresponds to it. */
const SMART_FACET: Record<SmartId, keyof LibraryFacets["smart"]> = {
  "this-week": "thisWeek",
  "last-30-days": "last30Days",
  large: "large",
  untagged: "untagged",
};

interface LibrarySidebarProps {
  /** Whole-library counts, aggregated by the backend. Every one except
   *  `trashed` is over the live captures, so each number is the number of
   *  rows its row will actually show. */
  facets: LibraryFacets;
  collections: Collection[];
  scope: LibraryScope;
  onScope: (scope: LibraryScope) => void;
  /** Active tag refinement, which is *not* a scope — it narrows whatever
   *  destination is open rather than replacing it. */
  tagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
  className?: string;
}

/**
 * The library's destination rail: everywhere the grid can be pointed,
 * with a live count beside each.
 *
 * Four groups, ordered by how permanent the thing is. **Library** holds
 * the fixed views the app itself defines (every capture, each kind, the
 * starred ones, the trash). **Collections** holds the arrangements the
 * user built by hand, and is the only group they can add to. **Smart**
 * holds rules re-evaluated on every render — nothing is stored, so these
 * can never drift out of date. **Tags** is the vocabulary the library
 * grew on its own.
 *
 * The counts matter more than they look: they are what makes this a map
 * of the library rather than a menu. Every one is over the same set the
 * row would open, so clicking a row never lands somewhere emptier than
 * its label promised.
 *
 * They arrive pre-aggregated (`useLibraryFacets`) rather than being
 * counted here. The rail spans the whole library while the grid beside it
 * holds one page, so counting these in the client would mean loading
 * every row purely to label the navigation — which is the cost paging the
 * grid was meant to remove (performance roadmap P5).
 */
export function LibrarySidebar({
  facets,
  collections,
  scope,
  onScope,
  tagFilter,
  onTagFilter,
  className,
}: LibrarySidebarProps) {
  const is = (candidate: LibraryScope) => sameScope(scope, candidate);

  return (
    <aside
      style={{ width: SIDEBAR_W }}
      className={cn(
        "shrink-0 flex-col overflow-y-auto border-r border-[color:var(--hairline)] bg-[var(--color-surface)] px-2.5 pb-5 pt-3",
        className
      )}
    >
      <Row
        icon={Layers}
        label="All media"
        count={facets.total}
        active={is({ kind: "all" })}
        onClick={() => onScope({ kind: "all" })}
      />

      <SectionLabel>Library</SectionLabel>
      {KIND_ORDER.map((kind) => (
        <Row
          key={kind}
          icon={KIND_ICON[kind]}
          label={KIND_LABEL[kind]}
          count={facets.kinds[kind] ?? 0}
          active={is({ kind: "kind", value: kind })}
          onClick={() => onScope({ kind: "kind", value: kind })}
        />
      ))}
      <Row
        icon={Star}
        label="Favorites"
        count={facets.favorites}
        active={is({ kind: "favorites" })}
        onClick={() => onScope({ kind: "favorites" })}
      />
      <Row
        icon={Trash2}
        label="Trash"
        count={facets.trashed}
        active={is({ kind: "trash" })}
        onClick={() => onScope({ kind: "trash" })}
      />

      <CollectionsSection
        collections={collections}
        scope={scope}
        onScope={onScope}
      />

      <SectionLabel>Smart collections</SectionLabel>
      {SMART_COLLECTIONS.map((def) => (
        <Row
          key={def.id}
          icon={SMART_ICON[def.id]}
          label={def.label}
          count={facets.smart[SMART_FACET[def.id]]}
          active={is({ kind: "smart", id: def.id })}
          onClick={() => onScope({ kind: "smart", id: def.id })}
        />
      ))}

      {facets.tags.length > 0 && (
        <>
          <SectionLabel>Tags</SectionLabel>
          {facets.tags.map(({ tag, count }) => {
            const active =
              tagFilter !== null &&
              tagFilter.toLowerCase() === tag.toLowerCase();
            return (
              <Row
                key={tag}
                label={tag}
                count={count}
                active={active}
                // A tag toggles rather than switches: it is a refinement
                // of whatever scope is open, so clicking the lit one takes
                // it off and leaves you where you were.
                onClick={() => onTagFilter(active ? null : tag)}
                leading={
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: `hsl(${tagHue(tag)} 66% 58%)` }}
                  />
                }
              />
            );
          })}
        </>
      )}
    </aside>
  );
}

/**
 * The Collections group — the only rail section the user writes to, so
 * it carries the create / rename / delete controls the old collections
 * rail used to hold.
 *
 * Deleting asks twice (the row's trash icon becomes "Delete?") because a
 * curated order is not recoverable: the captures survive, the
 * arrangement doesn't.
 */
function CollectionsSection({
  collections,
  scope,
  onScope,
}: {
  collections: Collection[];
  scope: LibraryScope;
  onScope: (scope: LibraryScope) => void;
}) {
  const [draft, setDraft] = useState<
    { mode: "create" } | { mode: "rename"; id: string } | null
  >(null);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft) inputRef.current?.focus();
  }, [draft]);

  // A pending "Delete?" the user walked away from must not stay armed —
  // the next stray click would take the collection with it.
  useEffect(() => {
    if (!confirmingDelete) return;
    const t = window.setTimeout(() => setConfirmingDelete(null), 4000);
    return () => window.clearTimeout(t);
  }, [confirmingDelete]);

  const closeDraft = () => {
    setDraft(null);
    setName("");
  };

  const submitDraft = async () => {
    const value = name.trim();
    if (!value || !draft) return closeDraft();
    try {
      if (draft.mode === "create") {
        const created = await collectionsCreate(value);
        onScope({ kind: "collection", id: created.id });
      } else {
        await collectionsRename(draft.id, value);
      }
    } catch (err) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Failed to save the collection."
      );
    }
    closeDraft();
  };

  const remove = async (id: string) => {
    try {
      await collectionsRemove(id);
      if (sameScope(scope, { kind: "collection", id }))
        onScope({ kind: "all" });
    } catch (err) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Failed to delete the collection."
      );
    }
    setConfirmingDelete(null);
  };

  return (
    <>
      <SectionLabel
        action={
          <IconBtn
            label="New collection"
            onClick={() => {
              setName("");
              setDraft({ mode: "create" });
            }}
          >
            <Plus size={13} strokeWidth={2.2} />
          </IconBtn>
        }
      >
        Collections
      </SectionLabel>

      {collections.length === 0 && !draft && (
        <p className="px-2.5 py-1 text-[11.5px] leading-snug text-[var(--color-hint)]">
          Group captures by hand — select a few and add them here.
        </p>
      )}

      {collections.map((c) =>
        draft?.mode === "rename" && draft.id === c.id ? (
          <DraftInput
            key={c.id}
            ref={inputRef}
            value={name}
            placeholder="Rename to…"
            ariaLabel="New name"
            onChange={setName}
            onSubmit={() => void submitDraft()}
            onCancel={closeDraft}
          />
        ) : (
          <Row
            key={c.id}
            icon={Folder}
            label={c.name}
            count={c.members.length}
            active={sameScope(scope, { kind: "collection", id: c.id })}
            onClick={() => onScope({ kind: "collection", id: c.id })}
            hoverActions={
              confirmingDelete === c.id ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(c.id);
                  }}
                  className="focus-ring rounded-[6px] bg-[color:var(--color-overlay-2)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--ed-danger,#f24822)]"
                >
                  Delete?
                </button>
              ) : (
                <>
                  <IconBtn
                    label={`Rename ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setName(c.name);
                      setDraft({ mode: "rename", id: c.id });
                    }}
                  >
                    <Pencil size={12} strokeWidth={1.9} />
                  </IconBtn>
                  <IconBtn
                    label={`Delete ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete(c.id);
                    }}
                  >
                    <Trash2 size={12} strokeWidth={1.9} />
                  </IconBtn>
                </>
              )
            }
          />
        )
      )}

      {draft?.mode === "create" && (
        <DraftInput
          ref={inputRef}
          value={name}
          placeholder="Collection name…"
          ariaLabel="New collection name"
          onChange={setName}
          onSubmit={() => void submitDraft()}
          onCancel={closeDraft}
        />
      )}
    </>
  );
}

/** Inline name field for creating or renaming a collection. */
function DraftInput({
  ref,
  value,
  placeholder,
  ariaLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  ref: Ref<HTMLInputElement>;
  value: string;
  placeholder: string;
  ariaLabel: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-1 py-0.5">
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="focus-ring h-7 min-w-0 flex-1 rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-2 text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-hint)]"
      />
      <IconBtn label="Save collection" onClick={onSubmit}>
        <Check size={13} strokeWidth={2.1} />
      </IconBtn>
      <IconBtn label="Cancel" onClick={onCancel}>
        <X size={13} strokeWidth={2.1} />
      </IconBtn>
    </div>
  );
}

/** Group heading, with an optional control on the right. */
function SectionLabel({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-2.5 pb-1 pt-4">
      <span className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--color-hint)]">
        {children}
      </span>
      {action}
    </div>
  );
}

/**
 * One destination row: icon, label, count.
 *
 * The count sits at the right edge and steps aside for `hoverActions`
 * when the pointer is over the row — a collection's rename / delete
 * controls have nowhere else to live in a 232px rail, and pinning them
 * open would turn a list of places into a list of toolbars.
 */
function Row({
  icon: Icon,
  label,
  count,
  active,
  onClick,
  leading,
  hoverActions,
}: {
  icon?: Icon;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** Rendered in the icon slot instead of `icon` — the tag dot. */
  leading?: ReactNode;
  hoverActions?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/row relative flex items-center rounded-[9px] transition-colors",
        active
          ? "bg-[color:var(--color-accent-soft)]"
          : "hover:bg-[color:var(--color-overlay-1)]"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={label}
        className={cn(
          "focus-ring flex h-[30px] min-w-0 flex-1 items-center gap-2.5 rounded-[9px] px-2.5 text-[12.5px] transition-colors",
          active
            ? "font-medium text-[var(--color-accent)]"
            : "text-[var(--color-slate)] hover:text-[var(--color-ink)]"
        )}
      >
        {leading ?? (Icon ? <Icon size={15} strokeWidth={1.75} /> : null)}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      <span
        className={cn(
          "pointer-events-none pr-2.5 text-[11px] tabular-nums text-[var(--color-hint)]",
          hoverActions ? "group-hover/row:hidden" : undefined
        )}
      >
        {count.toLocaleString()}
      </span>
      {hoverActions && (
        <span className="hidden items-center gap-0.5 pr-1.5 group-hover/row:flex group-focus-within/row:flex">
          {hoverActions}
        </span>
      )}
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: (e: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="focus-ring grid h-6 w-6 place-items-center rounded-[7px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
    >
      {children}
    </button>
  );
}

/**
 * A stable hue for a tag name.
 *
 * Derived rather than stored: tags are freeform and created by typing,
 * so there is no moment at which the user would pick a color, and a
 * persisted palette would need a migration the first time someone
 * renames one. The same tag always gets the same dot, which is all the
 * dot is for — telling two rows apart at a glance.
 */
function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i += 1) {
    h = (h * 31 + tag.toLowerCase().charCodeAt(i)) % 360;
  }
  return h;
}
