# PRODUCT — OpenTelemetry bridge: map constraints to span attributes

Issue: [#14](https://github.com/abhid1234/constraintguard/issues/14) · Consumes: #1 (constraint schema), #2 (`extract`), #8 (`conformance`) · Pairs with: #8

## Problem / motivation

ConstraintGuard can prove that declared constraints survive compaction (`conformance`, #8),
but that proof lives in a CLI or a JSON blob — invisible in the observability stack teams
already run. When an agent's trace shows up in Arize, LangSmith, or Braintrust, there is no
signal for *which constraints were declared* or *which ones were dropped* on that turn. This
issue adds an **OpenTelemetry bridge**: pure library functions that map ConstraintGuard's
existing data (a constraint set, a conformance result) to a flat, OTel-friendly attribute
object under a stable namespace. Any caller attaches that object to a span with whatever
exporter they already use, and "constraints pinned / dropped" becomes a first-class,
queryable trace attribute. We produce the attribute **shape** only — no OpenTelemetry SDK,
no runtime dependency.

## Recommended direction

Two decisions the issue flagged, both settled here.

### 1. Namespace: a custom `constraintguard.*` prefix (OTel-styled), not GenAI/OpenInference semconv

Attribute keys use a dot-namespaced, lowercase `constraintguard.*` prefix that follows
OpenTelemetry attribute-naming style but is our own reserved namespace.

- **There is no existing slot for this concept.** OTel GenAI semantic conventions
  (`gen_ai.*`) describe model calls, tokens, and prompts; OpenInference describes
  spans/sessions/retrieval. Neither has a notion of "declared constraints that survived a
  context compaction." Forcing our data into `gen_ai.*` would misrepresent it and collide
  with reserved keys.
- **Those conventions are still moving.** OTel GenAI semconv is explicitly experimental.
  Pinning our public attribute schema to a drifting external draft would break the
  zero-dependency, read-it-in-an-afternoon promise. A namespace we own is stable by
  construction and never collides with reserved conventions.
- **A custom prefix is honest and additive.** Any exporter can carry extra vendor
  attributes; `constraintguard.*` sits alongside whatever `gen_ai.*` / `openinference.*`
  keys the harness already emits, no conflict.

Rejected: mapping onto `gen_ai.*` (no constraint concept, reserved namespace) and onto
OpenInference span attributes (same gap). Both are one-line rejections in TECH.md.

### 2. What to model: the two data structures that exist today — a constraint **set** and a **conformance result** — as summary + id-list attributes; **not** pin/violation events (yet)

Ship two pure mappers, each returning a flat attribute object:

- **`constraintsToSpanAttributes(set)`** — for a validated constraint set (`{id, text, severity}[]`,
  the output of `extract` / the input to `validate`):

  ```json
  {
    "constraintguard.constraints.count": 2,
    "constraintguard.constraints.ids": ["no-pii", "terse"],
    "constraintguard.constraints.severity.must": 1,
    "constraintguard.constraints.severity.should": 1
  }
  ```

- **`conformanceToSpanAttributes(result)`** — for a conformance result (`{score, total, survived, dropped}`,
  the output of `scoreConformance`, #8):

  ```json
  {
    "constraintguard.conformance.score": 0.75,
    "constraintguard.conformance.total": 4,
    "constraintguard.conformance.survived": 3,
    "constraintguard.conformance.dropped.count": 1,
    "constraintguard.conformance.dropped.ids": ["no-pii"]
  }
  ```

**Why summary + id-lists, not per-constraint indexed objects.** OTel span-attribute values
must be primitives or homogeneous primitive arrays — never nested objects. Low-cardinality
counts plus a string array of ids answers the operational question ("*which* constraints were
declared / dropped?") directly, is cheap to index and query in a trace UI, and stays flat by
construction. Per-constraint indexed keys (`constraintguard.constraint.0.id`, `.0.severity`, …)
are possible but multiply key cardinality and are deferred.

**Why constraint text is deliberately excluded.** Constraint `text` can be long and can
itself carry sensitive policy detail; putting it into every span risks leaking it into a
third-party trace store. Ids and severities are the safe, useful signal. Emitting text is a
possible future opt-in (`includeText`), noted as an open question — not the default.

**Why not pin/violation events now.** The issue floats modeling pin or violation *events*.
Those data models do not exist in the codebase yet — `pin` (#7) is still a spec, and there is
no violation concept in `src/`. Mapping them would mean inventing an input shape we cannot
validate against real code, which is exactly what the "data model is stable today" triage note
warns against. The two mappers above cover the constraint set and the conformance result — the
structures that are stable today. Event mapping can follow once `pin` lands.

### 3. `cg otel` ships in this pass — a thin CLI over the two mappers

A `cg otel` subcommand ships, matching the existing `extract` / `conformance` command shape, so
the attribute JSON is usable straight from a shell (and testable end-to-end):

- `cg otel constraints [--strict] <context-file>` — extract constraints from the context
  (`extractConstraints`, #2), then print `constraintsToSpanAttributes(set)` as JSON.
- `cg otel conformance [--match id|exact] [--strict] <original> <compacted>` — score
  conformance (`scoreConformance`, #8), then print `conformanceToSpanAttributes(result)` as
  JSON.

Rejected: library-only (no CLI). The subcommand is small, mirrors the existing pattern, and
gives the mapper a shell entry point; the marginal surface is low. Kept as a firm decision but
flagged in Open Questions in case the reviewer prefers library-only for v1.

## Desired behavior

- **`constraintsToSpanAttributes(set)`** takes a constraint set (validated shape
  `{id, text, severity}[]`) and returns a flat object with only these keys:
  `constraintguard.constraints.count` (integer), `constraintguard.constraints.ids`
  (array of id strings, in the set's order), `constraintguard.constraints.severity.must`
  (integer count), `constraintguard.constraints.severity.should` (integer count). It
  validates its input against the #1 schema first, so a malformed set throws rather than
  producing garbage attributes.

- **Empty constraint set** returns a fully-populated, zeroed object — never an empty `{}`:
  `{ "constraintguard.constraints.count": 0, "constraintguard.constraints.ids": [],
  "constraintguard.constraints.severity.must": 0, "constraintguard.constraints.severity.should": 0 }`.
  A consumer can always read every key.

- **`conformanceToSpanAttributes(result)`** takes a `{score, total, survived, dropped}`
  object (as returned by `scoreConformance`) and returns:
  `constraintguard.conformance.score` (number in `[0,1]`), `.total` (integer), `.survived`
  (integer), `.dropped.count` (integer, `=== dropped.length`), `.dropped.ids` (array of the
  dropped constraints' ids, in `dropped` order).

- **`total === 0` conformance result** maps cleanly:
  `{ score: 1, total: 0, survived: 0, dropped.count: 0, dropped.ids: [] }` — the vacuous
  perfect score flows straight through.

- **Every returned value is OTel-legal**: a string, an integer, a float, or a homogeneous
  array of strings. No nested objects, no `null`, no `undefined`. The returned object can be
  spread directly into `span.setAttributes(...)`.

- **`cg otel constraints <file>`** prints the constraints attribute object as pretty JSON to
  stdout and exits `0`; **`cg otel conformance <orig> <compacted>`** prints the conformance
  attribute object as pretty JSON to stdout and exits `0`. Extraction warnings go to stderr
  (tagged by source file, reusing the #8 behavior for the conformance mode). A missing mode,
  wrong argument count, unknown flag, or unreadable file exits `1` with a clear stderr message.

- **The library exports both mapper functions** from `src/index.js` alongside the existing
  exports, and the attribute namespace is a documented, stable contract.

## Acceptance criteria

- [ ] `constraintsToSpanAttributes(set)` is pure and returns exactly the four
      `constraintguard.constraints.*` keys described above, with primitive / string-array
      values only.
- [ ] It validates its input via `validateConstraintSet` (#1) and throws on a malformed set.
- [ ] `constraintguard.constraints.ids` preserves the set's order; `.count` equals the number
      of constraints; `.severity.must` + `.severity.should` equals `.count`.
- [ ] Empty set → the zeroed object with all four keys present (`count: 0`, `ids: []`,
      `severity.must: 0`, `severity.should: 0`), never `{}`.
- [ ] `conformanceToSpanAttributes(result)` is pure and returns exactly the five
      `constraintguard.conformance.*` keys (`score`, `total`, `survived`, `dropped.count`,
      `dropped.ids`) with primitive / string-array values only.
- [ ] `.dropped.count === result.dropped.length` and `.dropped.ids` are the dropped
      constraints' ids in `dropped` order.
- [ ] `total === 0` result maps to `{ score:1, total:0, survived:0, dropped.count:0, dropped.ids:[] }`.
- [ ] No returned value is a nested object, `null`, or `undefined`; arrays are homogeneous
      strings — i.e. every value is directly OTel-attribute-legal.
- [ ] Both functions are re-exported from `src/index.js`.
- [ ] `cg otel constraints [--strict] <context-file>` prints the constraints attribute JSON to
      stdout, exit `0`; `cg otel conformance [--match id|exact] [--strict] <original> <compacted>`
      prints the conformance attribute JSON to stdout, exit `0`.
- [ ] `cg otel` with a missing/unknown mode, wrong positional count, unknown flag, or
      unreadable file exits `1` with a clear stderr message; `-h`/`--help` prints usage, exit `0`.
- [ ] Zero runtime dependencies; both mappers are deterministic (no I/O, clock, or randomness).
- [ ] `npm test` covers: non-empty and empty constraint mapping, severity split, malformed
      input throwing, non-empty and `total === 0` conformance mapping, dropped-ids order, and
      both `cg otel` CLI modes plus an error case.

## Non-goals

- **No OpenTelemetry SDK and no runtime dependency.** We emit the attribute *shape*; the
  caller attaches it with their own exporter. We never create spans, tracers, or exporters.
- **No alignment to `gen_ai.*` / OpenInference semantic conventions** in this pass (see
  Recommended direction). A future adapter could translate our namespace, but the emitted keys
  here are `constraintguard.*`.
- **No pin/violation event mapping.** Only the constraint set and the conformance result are
  modeled; event mapping waits for `pin` (#7) / a violation model to exist.
- **No constraint `text` in attributes** by default (privacy + cardinality); ids and
  severities only.
- **No per-constraint indexed attribute keys** (`…constraint.0.id`) in v1 — summary + id-list
  only.
- **No new data model or schema change.** The mappers consume the existing `{id, text, severity}`
  constraint and `{score, total, survived, dropped}` conformance shapes unchanged.

## Open questions (for the reviewer)

1. **Namespace — the primary gate.** Spec picks a custom `constraintguard.*` prefix over
   aligning to OTel GenAI / OpenInference semconv, because no existing convention models
   "constraints surviving compaction" and the conventions are still experimental. Confirm the
   custom prefix (and the exact key names / dotted structure), or say if you want a semconv
   alignment or a different prefix — this fixes the public schema and is hard to change later.
2. **Modeled shape.** Spec models the constraint **set** and the **conformance result** as
   summary counts + id arrays, and defers pin/violation events until those models exist.
   Confirm this is the right scope for v1, or ask for the per-constraint indexed-key variant.
3. **Constraint text.** Excluded by default for privacy/cardinality. Confirm text stays out,
   or that a future `includeText` opt-in is the right escape hatch.
4. **`cg otel` in this pass.** Spec ships the subcommand. Confirm, or scope v1 to library-only.
5. **Schema version marker (minor).** Should the attribute objects also carry a
   `constraintguard.schema.version` string so consumers can detect the namespace version?
   Left out of the core to keep it minimal; easy to add if wanted.
