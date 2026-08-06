import {
  act,
  configure,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureMeta } from "../types";

// Reaching the steady state is a cascade — fetch the first page, mount
// it, then auto-fetch the next — and each of these cases mounts a batch
// of real cards. The default 1s `waitFor` window is too tight for that
// when the whole suite runs in parallel on a loaded machine.
configure({ asyncUtilTimeout: 10_000 });

// Mock at the Tauri boundary rather than at our own client wrappers, so
// every real client / hook in the tree under test actually runs.
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { __resetThumbnailCacheForTests } from "../hooks/useThumbnail";
import { INITIAL_RENDERED } from "../hooks/useProgressiveRender";
import { useLibraryStore } from "../state/libraryStore";
import { LibraryLayout } from "./LibraryLayout";

type IOCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver
) => void;

/** Every observer the tree creates, so a test can drive one precisely
 *  instead of guessing which was constructed last (each card makes one
 *  for its thumbnail, and the progressive-render sentinel makes one). */
let observations: { el: Element; cb: IOCallback }[] = [];

class RecordingIO implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  constructor(private readonly cb: IOCallback) {}
  observe = (el: Element) => {
    observations.push({ el, cb: this.cb });
  };
  unobserve = () => {};
  disconnect = () => {};
  takeRecords = () => [];
}

const TOTAL = 500;
const NOW = 1_760_000_000_000;

/** A single day's worth of captures, newest first under the default sort. */
function captures(n: number): CaptureMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `/caps/cap-${i}.png`,
    title: `cap-${i}`,
    kind: "image" as const,
    createdAtMs: NOW - i * 1000,
    sizeBytes: 1024,
    trashed: false,
  }));
}

const ALL = captures(TOTAL);

/** Stand-in for the backend's SQL: enough of `library_query` to page and
 *  search, so the component is exercised over the path it really uses. */
function servePage(query: {
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const matched = query.search
    ? ALL.filter((m) => m.title.includes(query.search!))
    : ALL;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? matched.length;
  return {
    items: matched.slice(offset, offset + limit),
    total: matched.length,
  };
}

/** Whole-library counts, as the rail's aggregate call would answer. */
const FACETS = {
  total: TOTAL,
  kinds: { image: TOTAL },
  favorites: 3,
  trashed: 7,
  tags: [{ tag: "bug", count: 2 }],
  smart: { thisWeek: TOTAL, last30Days: TOTAL, large: 0, untagged: TOTAL },
};

beforeEach(() => {
  observations = [];
  invokeMock.mockReset();
  __resetThumbnailCacheForTests();
  globalThis.IntersectionObserver =
    RecordingIO as unknown as typeof IntersectionObserver;

  invokeMock.mockImplementation((command: string, args?: unknown) => {
    switch (command) {
      case "library_query":
        return Promise.resolve(
          servePage((args as { query: Parameters<typeof servePage>[0] }).query)
        );
      case "library_facets":
        return Promise.resolve(FACETS);
      // Only the two scopes a query can't express reach this.
      case "library_list":
        return Promise.resolve(ALL);
      case "collections_list":
        return Promise.resolve([]);
      case "library_thumbnail":
        return Promise.resolve(null);
      default:
        return Promise.resolve(undefined);
    }
  });

  useLibraryStore.setState({
    mode: "library",
    view: "grid",
    sort: "newest",
    kindFilter: "all",
    favoritesOnly: false,
    tagFilter: null,
    collectionId: null,
    smart: null,
    search: "",
    selected: [],
    focusedId: null,
    visibleIds: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** The progressive-render sentinel's observer callback, if it's mounted. */
function sentinel() {
  return observations.find((o) => o.el.classList.contains("h-px"));
}

/** Simulate the sentinel scrolling into view.
 *
 *  Waits for the sentinel rather than asserting it is already there. The
 *  caller has only awaited the *last card* of the batch; the sentinel is
 *  registered by an effect, and an effect is not guaranteed to have run
 *  by the time that text query resolves. Asserting synchronously turned
 *  that ordering into a coin flip — "expected undefined to be defined",
 *  on a run where nothing about the component had changed. */
async function scrollToSentinel() {
  await waitFor(() => expect(sentinel()).toBeDefined());
  const found = sentinel();
  act(() => {
    found?.cb(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });
}

/** Each case mounts a batch of real cards (motion wrapper, thumbnail
 *  observer, two store subscriptions apiece), which is comfortably the
 *  heaviest render in the suite — the default 5s can be tight when the
 *  whole suite runs in parallel on a loaded machine. */
const RENDER_TIMEOUT = 20_000;

describe("LibraryLayout paged library", () => {
  it(
    "mounts only the first batch of a large library",
    async () => {
      render(<LibraryLayout />);
      await waitFor(() =>
        expect(
          screen.getByText(`cap-${INITIAL_RENDERED - 1}`)
        ).toBeInTheDocument()
      );

      // The prefix is up, and nothing past it is in the DOM.
      expect(screen.getByText("cap-0")).toBeInTheDocument();
      expect(
        screen.queryByText(`cap-${INITIAL_RENDERED}`)
      ).not.toBeInTheDocument();
      expect(screen.queryByText(`cap-${TOTAL - 1}`)).not.toBeInTheDocument();
    },
    RENDER_TIMEOUT
  );

  it(
    "never asks the backend for the whole library",
    async () => {
      render(<LibraryLayout />);
      await waitFor(() =>
        expect(screen.getByText("cap-0")).toBeInTheDocument()
      );

      // The listing call is the thing P5 removes from this path.
      const commands = invokeMock.mock.calls.map(([c]) => c);
      expect(commands).not.toContain("library_list");
      expect(commands).toContain("library_query");
      expect(commands).toContain("library_facets");

      // And every page it did ask for was bounded.
      const pages = invokeMock.mock.calls
        .filter(([c]) => c === "library_query")
        .map(([, a]) => (a as { query: { limit?: number } }).query);
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.every((q) => (q.limit ?? Infinity) <= 100)).toBe(true);
    },
    RENDER_TIMEOUT
  );

  it(
    "reports the scope's true size, not how far it has loaded",
    async () => {
      render(<LibraryLayout />);
      await waitFor(() =>
        expect(screen.getByText("cap-0")).toBeInTheDocument()
      );

      // The toolbar reads the backend's match count …
      expect(screen.getByText(`${TOTAL} items`)).toBeInTheDocument();
      // … while the client is holding far fewer rows than that.
      expect(useLibraryStore.getState().visibleIds.length).toBeLessThan(TOTAL);
    },
    RENDER_TIMEOUT
  );

  it(
    "labels the rail from the whole-library aggregate",
    async () => {
      render(<LibraryLayout />);
      await waitFor(() =>
        expect(screen.getByText("cap-0")).toBeInTheDocument()
      );

      // Counts the grid's page cannot see: trashed rows, and a tag on rows
      // that were never loaded.
      expect(screen.getByText("Trash").closest("div")).toHaveTextContent("7");
      expect(screen.getByText("bug")).toBeInTheDocument();
    },
    RENDER_TIMEOUT
  );

  it(
    "mounts and fetches the next batch when the sentinel is reached",
    async () => {
      render(<LibraryLayout />);
      await waitFor(() =>
        expect(
          screen.getByText(`cap-${INITIAL_RENDERED - 1}`)
        ).toBeInTheDocument()
      );
      expect(
        screen.queryByText(`cap-${INITIAL_RENDERED}`)
      ).not.toBeInTheDocument();

      await scrollToSentinel();

      await waitFor(() =>
        expect(screen.getByText(`cap-${INITIAL_RENDERED}`)).toBeInTheDocument()
      );
      // Still bounded — one step, not the whole library.
      expect(screen.queryByText(`cap-${TOTAL - 1}`)).not.toBeInTheDocument();

      // Scrolling is what pulls rows through the backend: pages were
      // requested at increasing offsets rather than all at once.
      const offsets = invokeMock.mock.calls
        .filter(([c]) => c === "library_query")
        .map(
          ([, a]) => (a as { query: { offset?: number } }).query.offset ?? 0
        );
      expect(Math.max(...offsets)).toBeGreaterThan(0);
    },
    RENDER_TIMEOUT
  );

  it(
    "restarts the budget when the search narrows the list",
    async () => {
      render(<LibraryLayout />);
      // Settle at the steady state (a full budget mounted) before growing
      // it — until then the sentinel has nothing to observe.
      await waitFor(() =>
        expect(
          screen.getByText(`cap-${INITIAL_RENDERED - 1}`)
        ).toBeInTheDocument()
      );
      await scrollToSentinel();
      await waitFor(() =>
        expect(screen.getByText(`cap-${INITIAL_RENDERED}`)).toBeInTheDocument()
      );

      // A different list — the rows scrolled past aren't in it. The search
      // goes to the backend, so the grid restarts from a fresh first page.
      act(() => useLibraryStore.getState().setSearch("cap-4"));

      await waitFor(() =>
        expect(screen.queryByText("cap-0")).not.toBeInTheDocument()
      );
      expect(screen.getByText("cap-4")).toBeInTheDocument();

      // The needle reached SQL rather than being applied to loaded rows.
      const searches = invokeMock.mock.calls
        .filter(([c]) => c === "library_query")
        .map(([, a]) => (a as { query: { search?: string } }).query.search);
      expect(searches).toContain("cap-4");
    },
    RENDER_TIMEOUT
  );

  it(
    "falls back to the full listing only where a query can't express the scope",
    async () => {
      render(<LibraryLayout />);
      await waitFor(() =>
        expect(screen.getByText("cap-0")).toBeInTheDocument()
      );
      expect(invokeMock.mock.calls.map(([c]) => c)).not.toContain(
        "library_list"
      );

      // A smart collection is a rule over every row, not a WHERE clause.
      act(() =>
        useLibraryStore.getState().setScope({ kind: "smart", id: "large" })
      );

      await waitFor(() =>
        expect(invokeMock.mock.calls.map(([c]) => c)).toContain("library_list")
      );
    },
    RENDER_TIMEOUT
  );
});
