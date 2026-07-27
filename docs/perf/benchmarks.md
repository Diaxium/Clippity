# Performance benchmark harness

This is the repeatable native benchmark harness and budget gate called for
by **P2** in the [performance roadmap](../roadmaps/performance.md). It gives
the team a reproducible baseline and a CI-enforceable budget for the
CPU/IO-bound work a capture actually spends time in.

## What it measures

Automated [Criterion](https://bheisler.github.io/criterion.rs/book/) benches
live in `app/backend/crates/bench`:

| Criterion id | Covers |
| --- | --- |
| `scroll_stitch/stitch_24x1280x400` | Stitching a full scroll capture (24 overlapping 1280×400 frames). |
| `still_encode/png_encode_4k` | PNG-encoding a 4K RGBA still — the dominant CPU cost of selection-to-saved. |
| `thumbnail/thumb_4k_to_320` | Downscale + encode of a 4K still to a 320px card thumbnail. |
| `library_put/put_50k` | Inserting 50k rows into a fresh index (cold catalog rebuild). |
| `library_rows/rows_50k` | Listing **all** 50k rows — the pre-P5 full-list load the client filtered over. |
| `library_stamps/stamps_50k` | The staleness stamp map every library open builds over 50k rows. |
| `library_query/page_50` | **P5**: fetch one filtered/sorted page (50 of 50k) with the query pushed into SQL. |
| `library_query/search_50k` | **P5**: substring search over 50k rows returning a page. |
| `library_facets/facets_50k` | **P5**: the rail's whole-library counts (kinds, favorites, trash, smart sets, tag vocabulary). |

Corpora are **synthetic and deterministic** (`crates/bench/src/lib.rs`): a
fixed seed regenerates the same frames and rows byte-for-byte on every
machine, and no real capture content, window title or user data ever enters
a benchmark — the roadmap constraint is *timings and sizes only*.

## App-lifecycle metrics (tracked, not yet automated)

Cold/warm startup, hotkey-to-overlay, end-to-end still save, OCR, editor
drag fps, library first paint, idle CPU/RAM and installer size need a
running app, a model on disk, or a browser perf harness. They are listed in
`app/backend/benches-budgets.json` with their roadmap targets and
`"automated": false`, so the gap stays visible and the budget file is the
single source of truth. Wiring a native launch/soak driver for them is
follow-on work under P2.

## Running it

```bash
pnpm bench
```

That runs the Criterion suite (optimized `bench` profile — the first run
recompiles the dependency tree, later runs are fast) and writes results to
`app/backend/target/criterion/**/new/estimates.json`.

Then gate against the budgets:

```bash
pnpm bench:check
```

The checker (`scripts/check-bench-budgets.mjs`) reads each automated
metric's **median** and compares it to the `warn_ms` / `fail_ms` bands in
`app/backend/benches-budgets.json`. It exits non-zero if any metric is over
its fail band or has no result, prints warnings for the warn band, and lists
the manual metrics as tracked. In CI, run `pnpm bench` then `pnpm bench:check`
on the Windows runner.

## Reference baseline

First baseline (median), used to seed the warn/fail bands. Re-baseline on
your own runner before reading a breach as a regression.

| Metric | Median | warn / fail |
| --- | --- | --- |
| `scroll_stitch/stitch_24x1280x400` | 45.4 ms | 65 / 95 |
| `still_encode/png_encode_4k` | 159.5 ms | 210 / 320 |
| `thumbnail/thumb_4k_to_320` | 26.8 ms | 40 / 60 |
| `library_put/put_50k` | 254 ms | 340 / 500 |
| `library_rows/rows_50k` | 126 ms | 150 / 230 |
| `library_stamps/stamps_50k` | 33.2 ms | 48 / 70 |
| `library_query/page_50` | 2.1 ms | 5 / 12 |
| `library_query/search_50k` | 7.1 ms | 15 / 30 |
| `library_facets/facets_50k` | 46.4 ms | 65 / 110 |

`library_rows` (loading the whole listing) sits right at the roadmap's 150 ms
search budget at 50k rows — the concrete evidence that drove **P5**. The
`library_query/*` rows are P5's answer: `LibraryIndex::query` pushes the
grid's filters, search, sort and pagination into SQL, so a page costs
**2.1 ms** and a search **7.1 ms** instead of materializing all 50k rows.
That's the number a virtualized grid pays per page.

**P5 is now wired end to end.** The library page makes three bounded reads
where it used to make one unbounded one:

- the grid pages through `library_query` (`useLibraryQuery`) — **2.1 ms**;
- the rail reads `library_facets` (`useLibraryFacets`) — **46.4 ms**;
- the DOM is bounded on top of that (`useProgressiveRender` +
  `takeSections`): 120 cards mounted, growing by 120 as an
  `IntersectionObserver` sentinel is reached, which is also what pulls the
  next page.

Read the facets number honestly: **opening a 50k library costs ~48 ms of
native work rather than 126 ms** — a little under 3x, not the ~60x the page
figure alone suggests. The aggregate is inherently a full-table pass
(conditional sums, plus a `GROUP BY` over `json_each` for the tag
vocabulary), and it is the dominant remaining cost. What makes it
acceptable is *when* it runs: once per open and per `library/updated`,
never per keystroke, off the grid's critical path — the rail renders zeros
until it lands, so nothing blocks or reflows. If it needs to come down, the
tag `GROUP BY` is the piece to attack (a tags side-table instead of
`json_each`).

Two scopes deliberately still read the full listing, because neither is a
`WHERE` clause: a **smart collection** is a rule over every row, and a
**collection** is a curated id list whose order is its content. Entering one
pays `rows_50k`; every other destination never does. One behavioural
consequence of paging: on the paged path "Select all" selects the rows
loaded so far, since the client doesn't know the ids of rows it hasn't
fetched.

## Budgets and bands

`app/backend/benches-budgets.json` holds warn/fail bands per automated
metric and targets for the manual ones. **Bands are seeded from the first
baseline on reference hardware and must be re-tuned per runner** — a machine
slower or faster than the reference will shift every median, so treat a band
breach as a code regression only after confirming the baseline on that
runner. Criterion also keeps its own previous run as a `base/` comparison,
which surfaces run-over-run deltas independently of the absolute bands.

## Adding a metric

1. Add a `bench_function("id", …)` inside a named group in
   `crates/bench/benches/native.rs`, driven by a corpus from
   `crates/bench/src/lib.rs` (add a generator if needed, with a
   reproducibility test).
2. Add a matching `"<group>/<id>"` entry to `benches-budgets.json` with
   `warn_ms`/`fail_ms`.
3. Run `pnpm bench && pnpm bench:check` and tune the bands to the observed
   median.
