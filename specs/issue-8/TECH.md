# TECH — `cg conformance`

Issue: [#8](https://github.com/abhid1234/constraintguard/issues/8) · Depends on: #2 (`extractConstraints` in `src/extract.js`), #1 (`validateConstraintSet` in `src/schema.js`)

## Approach

Add a pure function `scoreConformance(original, compacted, opts)` in
`src/conformance.js`. It calls `extractConstraints` (#2) on each context string
to get two validated constraint sets, then, for every constraint in the original
set, decides whether an equivalent constraint exists in the compacted set under
the active match rule. It returns `{ score, total, survived, dropped }`, where
`total`/`survived` are counts, `dropped` is the array of original constraint
objects that were not matched (in original document order), and
`score = total === 0 ? 1 : survived / total`. A `conformance` subcommand in
`bin/cg.js` slots in beside `extract` as a sibling `case`: it parses two
positional file paths plus `--json`, `--threshold <t>`, `--match id|exact`, and
`--strict`, reads both files with `node:fs`, calls `scoreConformance`, prints a
human-readable report (or JSON under `--json`) to stdout, routes extraction
warnings to stderr tagged by source file, and sets the exit code from the
threshold check. Everything is Node standard library only; no wall-clock, no
randomness — fully deterministic.

### Matching
Because `extract` guarantees unique ids within each set, index the compacted set
by `id` once (`Map<id, {text, severity}>`), then test each original constraint:

- **`exact` (default):** survives iff `comp.has(c.id)` **and**
  `comp.get(c.id).text === c.text` **and** `comp.get(c.id).severity === c.severity`.
  (Equivalent to a deep-equal on the full `{ id, text, severity }` object, since
  ids are the unique key.)
- **`id`:** survives iff `comp.has(c.id)` — text and severity ignored.

Iterate the original set in order; push survivors' count, collect non-survivors
into `dropped`. No mutation of either extracted set.

### `total === 0`
Short-circuit: if the original set is empty, return
`{ score: 1, total: 0, survived: 0, dropped: [] }`. Division by zero is never
reached, and any `--threshold` in `[0, 1]` passes.

### CLI argument parsing (`conformance`)
- Two positional file paths required: `<original> <compacted>` (in that order).
  Zero, one, or three+ positionals → usage error, exit `1`.
- `--json` → emit the result object via `JSON.stringify(result, null, 2)`.
- `--match <id|exact>` → sets `opts.match`; any other value is a usage error.
  (`--match` default is `exact`.)
- `--threshold <t>` → parse with `Number(t)`; reject `NaN` or outside `[0, 1]`
  as a usage error (exit `1`).
- `--strict` → `opts.strict = true`, passed through to both extractions.
- `-h`/`--help` → print usage, exit `0`. Unknown `--flag` → usage error.
- Read each file with `readFileSync(path, 'utf8')`; an unreadable/missing file
  exits `1` with `conformance: cannot read <path>: <err>`.
- `opts.onWarning` prefixes each extraction warning with the file it came from,
  e.g. `warning: original.md: line 4: …`, written to stderr.

### Output & exit codes
- **Human (default):** first line `Conformance: <score to 2 dp>  (<survived>/<total> constraints survived)`;
  if `dropped.length > 0`, a `Dropped (<n>):` section listing each as
  `  - <severity> [<id>]: <text>`. For `total === 0`, append
  `— no constraints declared in the original context`.
- **`--json`:** the `{ score, total, survived, dropped }` object, pretty-printed,
  to stdout. Nothing else on stdout.
- **Exit code:**
  - `0` — ran successfully and (if `--threshold` given) `score >= threshold`.
  - `2` — ran successfully but `score < threshold` (the gate-failed signal).
  - `1` — operational/usage error: bad args, unknown flag, out-of-range
    threshold, unreadable file, or (under `--strict`) a malformed constraint line.
  Format never changes the code: `--json` with a failing threshold still exits `2`.

## Files / functions to touch

- **`src/conformance.js`** (new) — `export function scoreConformance(original, compacted, opts = {})`
  plus a small internal `matches(constraint, compIndex, mode)` helper and the
  compacted-set index builder. Pure; no I/O. Imports `extractConstraints` from
  `./extract.js`.
- **`src/index.js`** — re-export `scoreConformance` alongside the existing
  `VERSION`, `validateConstraintSet`, `extractConstraints`.
- **`bin/cg.js`** — add a `case 'conformance': return cmdConformance(rest);` to
  `main()`, a `cmdConformance(args)` function, and extend the top-level `USAGE`
  string to document `conformance` (e.g.
  `cg conformance [--json] [--match id|exact] [--threshold <t>] [--strict] <original> <compacted>`).
  Reuse the existing `fail()` helper for exit-`1` errors; use a separate
  `process.exit(2)` path for the threshold gate so it is not conflated with errors.
- **`test/conformance.test.js`** (new) — library coverage (below).
- **`test/cli.test.js`** — add `conformance` CLI cases (or a new
  `test/cli-conformance.test.js`), following the existing `spawnSync`/`fixture`
  harness.
- **`README.md`** (doc only, optional) — update the `cg conformance` example line
  to show the two file arguments and the `--json`/`--threshold` flags.

## Test plan (`npm test` → `node --test`)

Library (`scoreConformance`):
1. **Perfect retention** — identical original/compacted → `{ score: 1, total: n, survived: n, dropped: [] }`.
2. **Partial drop** — compacted omits one constraint block line → correct
   `score`, `survived`, and `dropped` (exact object, right order).
3. **`total === 0`** — original has no `constraints` block → `{ score: 1, total: 0, survived: 0, dropped: [] }`.
4. **Reworded text is dropped under `exact`** — same id (explicit `[id]`),
   different text → counted as dropped.
5. **Severity downgrade is dropped under `exact`** — same id + text, `must`→`should`
   in compacted → dropped.
6. **`--match id` survives a reword** — same case as (4) with `opts.match: 'id'`
   → survived, `dropped` empty.
7. **Determinism** — two calls on the same inputs return deep-equal results.
8. **`--strict` propagates** — a malformed line in either context throws when
   `opts.strict` is set.

CLI (`bin/cg.js conformance`):
9. **Human output + exit 0** — a fixture pair with one drop prints the
   `Conformance:` line and a `Dropped (1):` section, exit `0`.
10. **`--json` output** — stdout parses to `{ score, total, survived, dropped }`
    with the expected numbers; exit `0`.
11. **`--threshold` pass/fail** — `--threshold 0.5` on a `0.75` result exits `0`;
    `--threshold 0.9` exits `2`; both still print the report.
12. **Errors** — missing second file argument, unreadable file, and out-of-range
    `--threshold` each exit `1` with a clear stderr message.

## Risks / edge cases / migrations

- **Match-rule choice is load-bearing.** The score's meaning depends entirely on
  the `exact`-vs-`id` decision; PRODUCT flags it as the reviewer's primary gate.
  Implementation should not hardcode a third semantics.
- **Coupling to `extract` (#2).** Conformance inherits extract's parsing rules —
  what a "declared constraint" is, id generation, dedup. If a compacted context
  reformats a `constraints` block (e.g. re-slugs a generated id because the text
  changed), that constraint reads as dropped; this is correct rot detection, not
  a bug, but worth a test asserting the behavior.
- **Generated vs explicit ids under `--match id`.** id-only matching is only
  meaningful when ids are stable — i.e. explicit `[id]` markers, or unchanged
  text. Document that reworded text with a *generated* id changes the id and so
  drops even under `--match id`; `--match id` is for explicit-id workflows.
- **Exit-code collision.** Keep `2` (gate failed) strictly separate from `1`
  (error) so CI can distinguish "constraints rotted" from "tool broke." Do not
  route the threshold failure through `fail()`.
- **Empty / unreadable / non-UTF8 files** — handled at the CLI boundary with a
  non-zero exit and a clear message; the library treats empty text as an empty
  set (via extract), which flows into the `total === 0` case for the original.
- **Float formatting** — human output rounds `score` to 2 dp for display only;
  the JSON output and the threshold comparison use the exact float, so a value
  like `0.666…` is gated precisely, not on the rounded string.
- **No migration** — new file plus one export and one CLI case; no data or format
  change, no touch to `schema.js` or `extract.js`.

## Alternatives considered

- **id-only matching as the default** — simpler and reword-tolerant, but silently
  credits a constraint whose text was gutted while keeping its id, undercutting
  the "prove it works" guarantee. Kept as opt-in `--match id` instead.
- **Normalized-text matching** (lowercase + collapse whitespace before compare) —
  deterministic and catches trivial reformatting, but introduces a normalization
  spec surface and a middle ground that's neither exact nor id-stable. Deferred;
  can return behind a flag if a real need appears.
- **Fuzzy / edit-distance / embedding similarity** — best at catching genuine
  rewordings, but needs a threshold, isn't obviously reproducible, and (for
  embeddings) breaks the zero-dependency line. Rejected for v1.
- **Taking pre-extracted sets instead of raw contexts** — would drop the extract
  dependency, but the issue's contract and the CLI's job are both context-in; a
  string API keeps one clear entry point. Rejected.
- **Reporting added/changed constraints too** — useful diff view, but widens
  scope beyond a retention *score*; left as a possible future `--show-added`.
  Rejected for v1.
