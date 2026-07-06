# PRODUCT — A ConstraintRot reproduction benchmark

Issue: [#21](https://github.com/abhid1234/constraintguard/issues/21) · Depends on: #8 (`cg conformance` / `scoreConformance`, closed & implemented), #2 (`extract`), #1 (schema)

## Problem / motivation

ConstraintGuard's README and vision cite ConstraintRot (arXiv 2606.22528):
constraint-violation rates jump from 0% to as high as 59% after a context is
compacted. Right now that claim rests on someone else's paper — the repo ships
the scorer (`cg conformance`) that *could* prove it, but nothing that actually
*does*. We need a committed, reproducible benchmark that takes real
before/after sessions, runs our own `scoreConformance` over them, and prints a
retention table showing a measurable drop. That turns "constraints rot, trust
us" into "run `npm run bench` and watch them rot," which is exactly the
vision's "a conformance score that proves it works."

## Recommended direction

Two decisions the issue leaves open, resolved here:

**1. Fixtures: synthetic-first, committed, in a shape that also fits real
traces.** Ship a small set of hand-authored synthetic sessions in the repo so
`npm run bench` is deterministic, offline, and reproducible in CI with zero
setup. Each session is a directory of two plain context files — the exact same
`<original> <compacted>` shape `cg conformance` already consumes — so dropping
in real captured traces later is "add another folder," not a format change.
Rejected: starting with real captured traces (non-deterministic, needs
capture tooling that doesn't exist yet, and can't live in CI cleanly).

**2. Entry point: a dev-only `npm run bench` script, NOT a `cg bench`
subcommand.** The benchmark is a repo-internal harness bound to committed
fixtures — it is not a composable operation a user runs over their own data,
which is what the `cg` CLI is for. Keeping it out of `cg` holds the "small
composable operations" line, keeps the public CLI surface unchanged, and
(because `package.json`'s `files` whitelist already excludes `bench/`) keeps it
out of the published npm package. `npm run bench` runs `node bench/bench.js`.
Rejected: `cg bench` — it would bake fixture paths into the shipped CLI and add
a user-facing command that isn't a user operation.

**Reported match mode: `exact`.** The benchmark headlines the `exact` retention
score (same `id` + `text` + `severity`), because that is the honest, most
conservative reading of "the rule is still intact" and the one that surfaces rot
— a reworded or downgraded constraint reads as dropped. `--match id` is a
`conformance` escape hatch for a different workflow, not what a rot benchmark
should credit; the benchmark stays on `exact` for v1.

**Measurable-drop guarantee.** The whole point is to *reproduce* a drop, so the
benchmark is self-verifying: it exits non-zero if the committed fixtures do
**not** demonstrate a measurable drop (aggregate retention `>= 1.0`, i.e. every
constraint survived). This guards the README's headline claim against a future
change that silently makes the fixtures — or the scorer — stop showing rot.

## Desired behavior

- `npm run bench` reads every committed session under `bench/fixtures/*/`, runs
  `scoreConformance(original, compacted, { match: 'exact' })` on each, and prints
  a **retention table** to stdout, one row per session plus an aggregate row:

  ```
  ConstraintRot benchmark — 3 sessions, match=exact

  Session                     Total  Survived  Dropped  Retention
  ----------------------------------------------------------------
  summarization-safety            4         2        2      0.50
  truncation-policy               3         1        2      0.33
  reword-downgrade                4         3        1      0.75
  ----------------------------------------------------------------
  ALL                            11         6        5      0.55

  ConstraintRot: 45% of declared constraints dropped after compaction
  (retention 0.55 across 3 sessions).
  ```

- Each session directory holds `original.md` (the pre-compaction context,
  containing the declared `constraints` block) and `compacted.md` (the
  post-compaction context). The declared constraints are extracted from
  `original.md` — they are not stored separately.
- An optional per-session `meta.json` (`{ "label"?, "compaction"? }`) provides a
  human-readable label and a note on how the session was compacted
  (`"summarization"`, `"truncation"`, `"reword"`, …), shown in the table / a
  verbose mode. Absent `meta.json` → the directory name is the label.
- **Exit code:** `0` when the benchmark ran **and** the fixtures show a
  measurable drop (aggregate retention `< 1.0` with at least one dropped
  constraint). Exit **non-zero** if no drop is reproduced, if a fixture dir is
  malformed (missing `original.md`/`compacted.md`), or if there are zero
  sessions. The table still prints before a non-zero exit where possible.
- The committed synthetic fixtures cover the rot modes worth demonstrating: a
  constraint dropped entirely during summarization, a constraint lost to
  truncation, and (to show `exact` doing its job) a constraint whose text was
  reworded or whose severity was downgraded `must`→`should`.
- **Determinism:** same fixtures → identical table and exit code on every run.
  No wall-clock, no randomness, no network, no reading outside the repo.

## Acceptance criteria

- [ ] `npm run bench` exists (a `"bench"` script in `package.json`) and runs a
      dev-only `bench/bench.js` with `node` and zero runtime dependencies.
- [ ] Committed synthetic fixtures live under `bench/fixtures/<session>/` as
      `original.md` + `compacted.md` pairs (optional `meta.json`), and are
      excluded from the published package (not in `package.json` `files`).
- [ ] Fixtures include at least one session per rot mode: full drop under
      summarization, loss under truncation, and a reword / severity-downgrade
      that `exact` counts as dropped.
- [ ] The benchmark runs `scoreConformance(original, compacted, { match: 'exact' })`
      per session and prints a retention table: one row per session
      (label, total, survived, dropped, retention) plus an aggregate `ALL` row.
- [ ] A headline line reports the overall drop (dropped %/retention across all
      sessions), reproducing a ConstraintRot-style number from our own tooling.
- [ ] The aggregate retention over the committed fixtures is `< 1.0` (a real,
      measurable drop); `npm run bench` exits `0` on that, and exits non-zero if
      no drop is reproduced.
- [ ] Malformed fixture directory (missing `original.md` or `compacted.md`) and
      zero-session cases exit non-zero with a clear stderr message.
- [ ] The benchmark is deterministic: identical output and exit code across runs;
      no network, wall-clock, or randomness.
- [ ] The benchmark reuses the existing `scoreConformance` from `src/` unchanged
      — no new schema, no new `extract`/`conformance` behavior, no new public
      `cg` subcommand or library export.
- [ ] `npm test` covers the benchmark's aggregation logic (measurable drop from
      in-memory sessions) and that `npm run bench` over the committed fixtures
      exits `0` and prints the table.

## Non-goals

- **No `cg bench` subcommand** and **no new public library export.** The
  benchmark is a dev harness, not part of the shipped CLI or `src/index.js`.
- **No real captured traces in v1.** Synthetic fixtures only; the file-pair shape
  is chosen so real traces can be added later without a format change (a possible
  follow-up issue), but capturing them is out of scope here.
- **No change to `scoreConformance`, `extract`, or the schema.** The benchmark is
  a pure consumer of the existing scorer.
- **No `--match id` reporting, no fuzzy/semantic scoring, no per-session
  thresholds/policy files.** Headline is `exact` retention only.
- **No published-package impact, no runtime dependency, no network, no service or
  dashboard.** Table is plain text to stdout.
- **Not a general benchmarking framework** (no timing, no perf regression harness)
  — it measures constraint retention across compaction, nothing else.

## Open questions (for the reviewer)

1. **Entry point — the one public-surface call.** Spec recommends a dev-only
   `npm run bench` script over a `cg bench` subcommand, to keep the shipped CLI
   to composable user operations. Confirm, or say if you want `cg bench` exposed.
2. **Fixture source.** Spec recommends synthetic-first committed fixtures (with a
   trace-compatible shape) and defers real captured traces to a follow-up.
   Confirm synthetic-first is the right start.
3. **Fail-on-no-drop.** Spec makes `npm run bench` exit non-zero when the fixtures
   fail to reproduce a drop (aggregate retention `>= 1.0`), so the benchmark
   double-guards the README claim in CI. Confirm you want it to gate, versus
   print-only and always exit `0`.
