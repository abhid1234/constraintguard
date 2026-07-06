# TECH — ConstraintRot reproduction benchmark

Issue: [#21](https://github.com/abhid1234/constraintguard/issues/21) · Depends on: #8 (`scoreConformance` in `src/conformance.js`), #2 (`extractConstraints`), #1 (`validateConstraintSet`)

## Approach

Add a dev-only benchmark: a directory of committed synthetic fixtures plus a
plain Node script wired to `npm run bench`. Each fixture session is a directory
under `bench/fixtures/` holding `original.md` (pre-compaction context, with the
declared `constraints` block) and `compacted.md` (post-compaction context), and
an optional `meta.json` for a label / compaction note. `bench/bench.js`
discovers the session directories, reads each pair, and calls the **existing,
unchanged** `scoreConformance(original, compacted, { match: 'exact' })` from
`src/conformance.js`. It aggregates the per-session results into a retention
table, prints it to stdout, prints a headline drop percentage, and sets its exit
code from a "was a measurable drop reproduced?" check. To keep it testable, the
pure aggregation is factored into an exported `runBenchmark(sessions, opts)`
function (sessions passed in memory as `{ label, original, compacted }`), with a
thin `main()` doing all the I/O (directory scan, file reads, printing,
`process.exit`). Node standard library only; no wall-clock, no randomness — the
same fixtures always produce the same table and exit code.

## Layout & data shape

```
bench/
  bench.js                       # dev-only runner (NOT in package.json "files")
  fixtures/
    summarization-safety/
      original.md                # context with a ```constraints block
      compacted.md               # summarized context, some constraints gone
      meta.json                  # optional: { "label": "...", "compaction": "summarization" }
    truncation-policy/
      original.md
      compacted.md
    reword-downgrade/
      original.md
      compacted.md
```

- A **session** = a subdirectory of `bench/fixtures/` containing both
  `original.md` and `compacted.md`. Any subdirectory missing either file is a
  hard error (exit non-zero), not silently skipped.
- `meta.json` (optional): `{ "label"?: string, "compaction"?: string }`. `label`
  overrides the directory name in the table; `compaction` is a human note on how
  the compacted version was produced (shown in a `--verbose` mode). Malformed
  JSON in `meta.json` is an error.
- The declared constraints are **extracted from `original.md`** by
  `scoreConformance` → `extractConstraints`; they are not stored separately in
  the fixture. This keeps fixtures in the exact `<original> <compacted>` shape
  `cg conformance` consumes, so real traces slot in later unchanged.

## `runBenchmark(sessions, opts)` — the pure core

```
runBenchmark(sessions, opts = {}) -> {
  match,                 // 'exact'
  rows: [ { label, total, survived, dropped, score } , ... ],   // per session, input order
  totals: { total, survived, dropped, score },                  // aggregate over all sessions
  droppedAny,            // boolean: at least one constraint dropped somewhere
}
```

- `sessions`: `Array<{ label, original, compacted }>` (context **strings**).
- For each session, call `scoreConformance(original, compacted, { match })`
  (`match` defaults to `'exact'`) and record
  `{ label, total: r.total, survived: r.survived, dropped: r.dropped.length, score: r.score }`.
- Aggregate: `total = Σ total`, `survived = Σ survived`, `dropped = Σ dropped`;
  aggregate `score = total === 0 ? 1 : survived / total` (constraint-weighted, not
  a mean of per-session scores — a session with more constraints counts more,
  which is the honest ConstraintRot number).
- `droppedAny = totals.dropped > 0`.
- Pure: no I/O, no `process`, no printing. Deterministic given `sessions`.

## `bench/bench.js` — the runner (`main`)

1. **Discover** sessions: read `bench/fixtures/` (path resolved from
   `import.meta.url`, not `process.cwd()`, so `npm run bench` works from anywhere),
   list subdirectories in sorted order for stable output. Zero sessions → error.
2. **Load** each: `readFileSync(original.md)`, `readFileSync(compacted.md)` as
   utf8; parse optional `meta.json`. Missing file / bad JSON → collect a clear
   error and exit non-zero. `label = meta.label ?? dirname`.
3. **Run** `runBenchmark(sessions, { match: 'exact' })`.
4. **Print** the table to stdout: a header
   (`ConstraintRot benchmark — <n> sessions, match=exact`), aligned columns
   `Session | Total | Survived | Dropped | Retention`, one row per session, a
   rule, an `ALL` aggregate row, then a headline line:
   `ConstraintRot: <dropped%>% of declared constraints dropped after compaction (retention <score2dp> across <n> sessions).`
   `--verbose` additionally prints each session's `compaction` note and its
   dropped constraints (`- <severity> [<id>]: <text>`), reusing the shape of
   `formatConformance` in `bin/cg.js`.
5. **Exit code:**
   - `0` — ran and reproduced a measurable drop: `totals.score < 1` **and**
     `droppedAny`.
   - non-zero (`1`) — no drop reproduced (`totals.score >= 1` / `!droppedAny`),
     zero sessions, or any load error (missing fixture file, bad `meta.json`).
   The retention table is printed before the non-zero exit whenever the run got
   far enough to compute it.

Scoring/percentage formatting is display-only (2 dp / rounded %); the exit-code
check uses the exact float, mirroring `conformance`'s float handling.

## Files / functions to touch

- **`bench/bench.js`** (new) — `export function runBenchmark(sessions, opts)` (pure
  aggregator) + `main()` (discovery, I/O, table printing, exit code) guarded so
  it only runs when invoked as the entry module. Imports `scoreConformance` from
  `../src/conformance.js` (or `../src/index.js`). Uses `node:fs`, `node:path`,
  `node:url` only.
- **`bench/fixtures/<session>/{original.md,compacted.md[,meta.json]}`** (new) — the
  committed synthetic sessions (≥3, one per rot mode: summarization drop,
  truncation loss, reword/severity-downgrade).
- **`package.json`** — add `"bench": "node bench/bench.js"` to `scripts`. **Do not**
  add `bench` to the `files` whitelist — it must stay dev-only / unpublished.
- **`test/bench.test.js`** (new) — library + smoke coverage (below).
- **`README.md`** (doc only, optional) — a line noting `npm run bench` reproduces
  the ConstraintRot drop from committed fixtures.

No change to `src/` (schema, extract, conformance, index, pin, otel, harness) and
no new `cg` subcommand — the benchmark is a pure consumer of `scoreConformance`.

## Test plan (`npm test` → `node --test`)

Pure core (`runBenchmark`, in-memory sessions — no fixture I/O):
1. **Measurable drop** — sessions where the compacted context omits a constraint
   → `totals.score < 1`, `droppedAny === true`, per-row counts correct.
2. **Constraint-weighted aggregate** — two sessions of different sizes → aggregate
   `score === Σsurvived / Σtotal`, not the mean of the two per-session scores.
3. **Perfect retention** — identical original/compacted across sessions →
   `totals.score === 1`, `droppedAny === false` (this is the case `main` must fail on).
4. **`total === 0` session** — a session with no `constraints` block contributes
   `total 0, survived 0` and doesn't break the aggregate (`score` still defined).
5. **Determinism** — two calls on the same sessions return deep-equal results.

Runner / fixtures (spawn or import `main` boundary):
6. **`npm run bench` over committed fixtures** — `spawnSync` the script; exit `0`,
   stdout contains the header, an `ALL` row, and the `ConstraintRot:` headline;
   aggregate retention parsed from output is `< 1.0`.
7. **Fixtures actually drop** — assert the committed fixtures yield
   `survived < total` in aggregate (guards the README claim).
8. **Malformed fixture** — a session dir missing `compacted.md` (constructed in a
   temp dir, or asserted via a unit on the loader) → non-zero exit, clear stderr.
9. **No-drop gate** — a fixture set with perfect retention → non-zero exit
   (exercised via `runBenchmark` + the exit-decision helper, to avoid mutating the
   committed fixtures).

## Risks / edge cases / migrations

- **Fixtures must keep dropping.** If a future edit to `extract`/`conformance` or
  to a fixture makes retention hit `1.0`, the benchmark's reason to exist
  evaporates. The fail-on-no-drop exit code is the guardrail; test 7 backs it.
- **`exact` coupling to `extract` id generation.** Under `exact`, a reworded
  constraint with a *generated* id drops for two compounding reasons (id changed
  *and* text changed). That's correct rot detection, but fixtures intending to
  demonstrate a pure reword-vs-`exact` case should use an explicit `[id]` so the
  drop is attributable to the text/severity change, not an id reslug. Document
  this in the reword fixture.
- **Path resolution.** Resolve `bench/fixtures/` from `import.meta.url`, never
  `process.cwd()`, so `npm run bench` and the test spawn both work regardless of
  the working directory.
- **Published-package hygiene.** `bench/` must not enter `package.json` `files`;
  the fixtures and runner are dev-only. A stray addition would ship synthetic
  fixtures to npm — call it out in review.
- **Determinism of directory scan.** Sort the discovered session directories so
  the table order is stable across filesystems.
- **Aggregate weighting choice.** Constraint-weighted (`Σsurvived/Σtotal`) is the
  faithful ConstraintRot number and is what the headline should report; a mean of
  per-session scores would over/under-weight small sessions. Chosen deliberately;
  test 2 pins it.
- **No migration** — purely additive: one new dir, one `package.json` script line,
  one test file. No data-format or public-API change.

## Alternatives considered

- **`cg bench` subcommand** — puts the harness in the shipped CLI, but bakes
  fixture paths into the public surface and adds a non-user command; rejected in
  favor of a dev-only `npm run bench` (see PRODUCT open question 1).
- **Single JSON manifest of `{ name, original, compacted }` strings** — more
  compact than file pairs, but diverges from the `<original> <compacted>` file
  shape that `cg conformance` and real captured traces take; rejected to keep
  fixtures trace-compatible.
- **Real captured traces for v1** — most convincing, but non-deterministic, needs
  capture tooling that doesn't exist, and can't sit in CI cleanly; deferred to a
  follow-up, with the fixture shape chosen to accept them later.
- **Reporting `--match id` (or both modes)** — id-only under-reports rot by
  crediting gutted-but-same-id constraints; the benchmark headlines `exact`, the
  honest number. Rejected for v1.
- **Mean-of-per-session-scores aggregate** — simpler to describe but
  misrepresents the overall drop; constraint-weighted is the real ConstraintRot
  figure. Rejected.
- **Putting the aggregator in `src/index.js`** — would add a public export for a
  dev-only concern; kept inside `bench/` so the shipped library surface is
  unchanged. Rejected.
