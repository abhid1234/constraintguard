# TECH — OpenTelemetry bridge (`src/otel.js`, `cg otel`)

Issue: [#14](https://github.com/abhid1234/constraintguard/issues/14) · Consumes: `validateConstraintSet` (`src/schema.js`, #1), `extractConstraints` (`src/extract.js`, #2), `scoreConformance` (`src/conformance.js`, #8)

## Approach

Add a new pure module `src/otel.js` exporting two functions that map existing
ConstraintGuard data to flat, OpenTelemetry-legal attribute objects under a stable
`constraintguard.*` namespace:

- `constraintsToSpanAttributes(set)` — validates `set` via `validateConstraintSet` (#1),
  then returns `{ 'constraintguard.constraints.count', '.ids', '.severity.must', '.severity.should' }`.
- `conformanceToSpanAttributes(result)` — returns
  `{ 'constraintguard.conformance.score', '.total', '.survived', '.dropped.count', '.dropped.ids' }`
  from a `{ score, total, survived, dropped }` object.

An **OTel-legal** value is a string, a finite number (integer or double), a boolean, or a
homogeneous array of one of those. Both functions emit only integers, one double (`score`),
strings, and string arrays — never nested objects, `null`, or `undefined` — so the returned
object can be passed straight to `span.setAttributes(...)`. No OpenTelemetry SDK is imported;
the module is Node-standard-library-only, pure, and deterministic (no I/O, clock, or
randomness). A `cg otel` subcommand in `bin/cg.js` slots in beside `extract` / `conformance`
as a sibling `case`, reads context/​result from files, calls the mappers, and prints the
attribute object as pretty JSON to stdout.

### Namespace and key schema (the public contract)

Prefix: `constraintguard.` — lowercase, dot-namespaced, following OTel attribute-naming style
but reserved to this project. Exact keys:

**`constraintsToSpanAttributes(set)`**

| key | type | value |
| --- | --- | --- |
| `constraintguard.constraints.count` | int | `set.length` |
| `constraintguard.constraints.ids` | string[] | ids in `set` order |
| `constraintguard.constraints.severity.must` | int | count of `severity === 'must'` |
| `constraintguard.constraints.severity.should` | int | count of `severity === 'should'` |

**`conformanceToSpanAttributes(result)`**

| key | type | value |
| --- | --- | --- |
| `constraintguard.conformance.score` | double | `result.score` (exact float, not rounded) |
| `constraintguard.conformance.total` | int | `result.total` |
| `constraintguard.conformance.survived` | int | `result.survived` |
| `constraintguard.conformance.dropped.count` | int | `result.dropped.length` |
| `constraintguard.conformance.dropped.ids` | string[] | dropped constraint ids, in `dropped` order |

`.dropped.count` (scalar) and `.dropped.ids` (array) sit under a `dropped` sub-namespace so the
count key never collides with the array key. The same reasoning keeps `constraints.count` /
`constraints.ids` flat while severities live under `constraints.severity.*`.

### Empty / edge cases

- **Empty constraint set** → every key present and zeroed:
  `{ 'constraintguard.constraints.count': 0, 'constraintguard.constraints.ids': [],
  'constraintguard.constraints.severity.must': 0, 'constraintguard.constraints.severity.should': 0 }`.
  Never `{}` — consumers can read all four keys unconditionally.
- **`total === 0` conformance result** → `score: 1, total: 0, survived: 0, dropped.count: 0,
  dropped.ids: []` (flows through directly; no special-casing needed beyond mapping).
- **Input validation.** `constraintsToSpanAttributes` calls `validateConstraintSet(set)` first
  and lets it throw on a malformed set (non-array, missing field, bad severity, duplicate id),
  so attributes are only ever produced from a valid set. `conformanceToSpanAttributes` assumes
  a well-formed `scoreConformance` result; it reads `dropped` defensively (treats a
  missing/empty array as no drops) but does not re-validate the constraint objects inside it.

### CLI: `cg otel <mode> …`

Two modes mirror the two mappers and reuse the existing extract/conformance plumbing:

- `cg otel constraints [--strict] <context-file>`
  → `extractConstraints(read(file), { strict, onWarning→stderr })` → `constraintsToSpanAttributes(set)`
  → `JSON.stringify(attrs, null, 2)` to stdout, exit `0`.
- `cg otel conformance [--match id|exact] [--strict] <original> <compacted>`
  → `scoreConformance(read(orig), read(comp), { match, strict, onWarning→stderr tagged by file })`
  → `conformanceToSpanAttributes(result)` → pretty JSON to stdout, exit `0`.

Parsing rules (consistent with `cmdExtract` / `cmdConformance`):
- First positional token is the **mode** (`constraints` | `conformance`); missing or unknown
  mode → usage error, exit `1`.
- `constraints` mode requires exactly one file path; `conformance` mode requires exactly two.
  Wrong count → usage error, exit `1`.
- `--strict` passes through to extraction; `--match id|exact` (conformance mode only, default
  `exact`) validated as in #8 — any other value is a usage error.
- `-h`/`--help` prints usage, exit `0`. Unknown `--flag` → usage error. Unreadable file →
  `otel: cannot read <path>: <err>`, exit `1` (reuse the existing `fail()` / `readContext`
  helpers).
- Extraction warnings → stderr, tagged with the source file in conformance mode (same as #8).

Only stdout carries the JSON; warnings and errors go to stderr. No `--threshold`/exit-`2`
semantics here — `otel` is a pure printer, always exit `0` on success.

## Files / functions to touch

- **`src/otel.js`** (new) — `export function constraintsToSpanAttributes(set)` and
  `export function conformanceToSpanAttributes(result)`, plus a tiny internal `NS` prefix
  constant (`'constraintguard'`) or literal keys. Imports only `validateConstraintSet` from
  `./schema.js`. Pure; no I/O.
- **`src/index.js`** — re-export both functions alongside `VERSION`, `validateConstraintSet`,
  `extractConstraints`, `scoreConformance`.
- **`bin/cg.js`** — add `case 'otel': return cmdOtel(rest);` to `main()`; add `cmdOtel(args)`
  that dispatches on the mode token and reuses `readContext`, `fail`, and the existing
  extract/conformance calls; extend the top-level `USAGE` string with the two `cg otel …`
  forms. Import `constraintsToSpanAttributes` / `conformanceToSpanAttributes` from `../src/index.js`.
- **`test/otel.test.js`** (new) — library coverage (below).
- **`test/cli-otel.test.js`** (new) — CLI coverage, following the `spawnSync`/fixture harness
  in `test/cli-conformance.test.js`.
- **`README.md`** (doc only) — add a `cg otel` example line to the command list and one line
  noting the `constraintguard.*` attribute namespace.

## Test plan (`npm test` → `node --test`)

Library (`src/otel.js`):
1. **Constraints, non-empty** — a set with two `must` + one `should` → `count: 3`, `ids` in
   order, `severity.must: 2`, `severity.should: 1`; assert the object has exactly those four keys.
2. **Constraints, empty** — `[]` → the zeroed four-key object (not `{}`); `ids` is `[]`.
3. **Constraints, malformed input throws** — a non-array / missing-field set throws (delegated
   to `validateConstraintSet`).
4. **Constraints, id order preserved** — ids come out in set order, verbatim.
5. **Conformance, non-empty** — `{ score: 0.75, total: 4, survived: 3, dropped: [{id:'no-pii',…}] }`
   → the five keys with `dropped.count: 1`, `dropped.ids: ['no-pii']`, `score: 0.75` (exact).
6. **Conformance, `total === 0`** — `{ score:1, total:0, survived:0, dropped:[] }` →
   `dropped.count: 0`, `dropped.ids: []`, `score: 1`.
7. **Conformance, dropped order** — multiple dropped constraints → `dropped.ids` matches
   `dropped` order.
8. **OTel-legality** — for both mappers, assert every value is a string, finite number, or an
   array of strings (no object/null/undefined) — a small helper walking the returned object.
9. **Purity/determinism** — two calls on the same input are deep-equal.

CLI (`bin/cg.js otel`):
10. **`otel constraints <file>`** — a fixture context prints JSON that parses to the expected
    constraints attribute object; exit `0`.
11. **`otel conformance <orig> <compacted>`** — a fixture pair with one drop prints JSON that
    parses to the expected conformance attribute object (`dropped.ids` correct); exit `0`.
12. **Errors** — missing mode, wrong positional count, unknown flag, and unreadable file each
    exit `1` with a clear stderr message; `-h` exits `0` with usage.

## Risks / edge cases / migrations

- **Namespace is load-bearing and hard to change.** Once emitted into traces, the
  `constraintguard.*` keys become a de-facto public schema. PRODUCT flags namespace as the
  primary reviewer gate; implementation should centralize the prefix (one constant) so a
  reviewer-driven rename is a one-line change, and must not invent extra keys beyond the spec.
- **OTel value-type discipline.** The single most important invariant is "no nested objects,
  no null, homogeneous arrays." Test 8 enforces it; keep it as a guard so a future field
  addition can't silently emit an illegal value.
- **`score` precision.** Emit the exact float, not the human-rounded 2-dp string (#8 rounds
  only for display). Trace backends store it as a double; consumers can bucket/threshold on the
  real value.
- **Empty vs absent keys.** Always emit the full key set (zeroed) rather than omitting keys,
  so downstream queries (`WHERE constraintguard.constraints.count = 0`) work without
  null-handling. Test 2 pins this.
- **Coupling to upstream shapes.** The mappers depend on the `{id, text, severity}` constraint
  and `{score, total, survived, dropped}` conformance shapes. If #1 or #8 changes those, these
  mappers must follow — but neither is changed here, and both shapes are stable in `src/` today.
- **Privacy.** `text` is intentionally excluded so constraint bodies don't leak into
  third-party trace stores; a future `includeText` opt-in must be explicit, never default.
- **No migration.** New module + two exports + one CLI case + tests. No data/format change; no
  edits to `schema.js`, `extract.js`, or `conformance.js`.

## Alternatives considered

- **Align to OTel GenAI (`gen_ai.*`) semantic conventions** — no attribute models "declared
  constraints surviving compaction," the namespace is reserved for model/token telemetry, and
  the convention is still experimental. Rejected; would misrepresent the data and pin us to a
  moving target.
- **Align to OpenInference span attributes** — same gap (spans/retrieval/sessions, no
  constraint concept). Rejected.
- **Per-constraint indexed keys** (`constraintguard.constraint.0.id`, `.0.severity`, …) —
  preserves full per-item detail, but multiplies key cardinality and complicates queries with
  no clear v1 need. Deferred; summary counts + `ids` array answer "which constraints?" already.
- **Parallel arrays for id↔severity** (`.ids` + `.severities`) — compact, but correlating two
  arrays by index is awkward in a trace UI; severity *counts* are the more useful summary.
  Rejected in favor of `severity.must` / `severity.should` counts.
- **Include constraint `text`** — richer, but risks leaking sensitive policy text into external
  traces and inflates attribute size. Deferred to an explicit opt-in.
- **Model pin/violation events now** — the issue floats it, but no pin/violation data model
  exists in `src/` yet (`pin` is spec #7). Rejected for v1; revisit once the model lands.
- **Library-only, no `cg otel`** — smaller surface, but the CLI is thin, mirrors the existing
  command pattern, and gives the mapper a shell entry point + end-to-end tests. Kept; flagged
  as an open question in case the reviewer prefers library-only.
- **Return an array of `{key, value}` pairs instead of an object** — some SDKs want pairs, but
  a plain flat object spreads directly into `setAttributes` and is the most portable shape.
  Rejected.
