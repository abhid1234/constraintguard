# PRODUCT — `cg conformance`: score how well constraints survive compaction

Issue: [#8](https://github.com/abhid1234/constraintguard/issues/8) · Depends on: #2 (`extract`), #1 (constraint schema)

## Problem / motivation

ConstraintGuard's promise — that declared rules survive context compaction — is
only credible if it can be *measured*. When an agent summarizes its history to
fit the window, safety and policy constraints silently vanish; the ConstraintRot
study (arXiv 2606.22528) measured constraint-violation rates jumping from 0% to
as high as 59% after compaction. `cg conformance <original> <compacted>` is the
deterministic, dependency-free score that proves (or disproves) survival: it
extracts the constraints declared in the *original* context, checks how many are
still declared in the *compacted* context, and reports a retention score plus the
exact list of constraints that were dropped. Two real decisions — *what counts as
"survived"* and *the CI exit-code contract* — are resolved below.

## Recommended direction

**Survival is an exact match on the constraint object.** A constraint declared in
the original context has *survived* iff the compacted context, after extraction,
declares a constraint with the **same `id`, same `text`, and same `severity`**.
This is the most honest, conservative reading of "the rule is still intact":

- It is fully deterministic and zero-dependency — no edit-distance, no
  normalization heuristics, no LLM. The same two contexts always produce the same
  score, which is what makes the number trustworthy.
- It over-credits nothing. A rule whose text was reworded, or whose severity was
  downgraded from `must` to `should` during compaction, is *not* the same rule —
  it counts as dropped, which is exactly the rot we want to surface.
- It composes cleanly with `extract` (#2): extract already assigns each
  constraint a stable, unique `id` (explicit `[id]` verbatim, else a
  deterministic slug of the text), so matching by the full object is unambiguous.

**Escape hatch for stable-id workflows: `--match id`.** Authors who use explicit
`[id]` markers and deliberately reword constraint text can opt into id-only
matching, where a constraint survives iff its `id` is present in the compacted
set (text and severity may differ). This is a genuinely different, legitimate
workflow, so it earns one flag — but `exact` is the default because it holds the
"prove it works" line.

Rejected for v1 (see TECH.md): normalized-text matching (lowercase/whitespace-
collapse before comparing) and fuzzy/edit-distance matching — both add a
matching-semantics surface and, for fuzzy, non-obvious thresholds, without a
compelling default; they can return later behind a flag if a real need appears.

## Desired behavior

- `cg conformance original.md compacted.md` extracts constraints from both files
  (reusing `extract`), computes retention, and prints a **human-readable** report
  to **stdout**:

  ```
  Conformance: 0.75  (3/4 constraints survived)
  Dropped (1):
    - must [no-pii]: Never include personal data in output.
  ```

  With nothing dropped it prints `Conformance: 1.00  (4/4 constraints survived)`
  and no `Dropped` section. Exit `0`.

- **`total === 0` is a defined, non-error case.** If the original context declares
  no constraints, there is nothing to lose: `score` is `1`, `survived` is `0`,
  `dropped` is empty, and the CLI prints a clear note
  (`Conformance: 1.00  (0/0) — no constraints declared in the original context`).
  Exit `0`, and any `--threshold` passes (1 ≥ t for every t in [0, 1]).

- **`--json`** prints the result object to stdout instead of the human report, for
  CI: `{ "score": 0.75, "total": 4, "survived": 3, "dropped": [ … ] }`, where each
  `dropped` entry is the full original constraint object. Exit-code semantics are
  identical to human mode.

- **`--threshold <t>`** turns the command into a CI gate. `t` is a number in
  `[0, 1]`. If `score < t`, the command exits **non-zero** (a distinct "gate
  failed" code) after still printing the report; if `score >= t`, it exits `0`.
  Without `--threshold`, `conformance` is a pure report and exits `0` whenever it
  ran successfully, regardless of score.

- **`--match id`** switches survival to id-only matching (see above).
  **`--strict`** propagates to the extraction of *both* files, so a malformed
  constraint line becomes a non-zero exit rather than a skipped-with-warning line.
  Extraction warnings from either file are routed to **stderr**, prefixed so the
  reader can tell which file they came from.

- The library exposes the same logic as a pure function,
  `scoreConformance(original, compacted, opts)`, taking the two context **strings**
  and returning `{ score, total, survived, dropped }`.

## Return shape (library)

`scoreConformance(original, compacted, opts = {})` → `{ score, total, survived, dropped }`

- **`total`** — number of constraints extracted from the *original* context.
- **`survived`** — count of original constraints found intact in the compacted
  context under the active match rule.
- **`dropped`** — array of the full original constraint objects
  (`{ id, text, severity }`) that did **not** survive, in original document order.
- **`score`** — `survived / total`, a number in `[0, 1]`; `1` when `total === 0`.

`opts`: `{ match: 'exact' | 'id' (default 'exact'), strict: boolean, onWarning: fn }`.

## Acceptance criteria

- [ ] `scoreConformance(original, compacted, opts)` is pure and returns
      `{ score, total, survived, dropped }`, extracting constraints from both
      context **strings** via `extractConstraints` (#2).
- [ ] `score === survived / total`, always in `[0, 1]`; `total === 0` yields
      `{ score: 1, total: 0, survived: 0, dropped: [] }`.
- [ ] Default (`exact`) match: an original constraint survives iff the compacted
      set contains a constraint with the same `id`, `text`, **and** `severity`.
- [ ] A reworded text or a `must`→`should` downgrade counts as **dropped** under
      `exact`.
- [ ] `--match id` / `opts.match === 'id'`: an original constraint survives iff
      its `id` is present in the compacted set (text/severity may differ).
- [ ] `dropped` contains the full original constraint objects that did not
      survive, in original document order; `survived` and `total` are counts.
- [ ] CLI `cg conformance <original> <compacted>` prints the human-readable score
      and dropped list to stdout and exits `0` on success.
- [ ] `--json` prints the result object as JSON to stdout; exit-code semantics
      are unchanged by the output format.
- [ ] `--threshold <t>` (t in `[0, 1]`): `score < t` exits with the distinct
      gate-failure code; `score >= t` exits `0`. An out-of-range or non-numeric
      threshold is a usage error (exit `1`).
- [ ] `--strict` propagates to extraction of both files; a malformed line exits
      non-zero. Extraction warnings go to stderr, tagged with the source file.
- [ ] A missing/unreadable file, missing/extra positional argument, or unknown
      option exits `1` with a clear stderr message.
- [ ] Zero runtime dependencies; the scorer is pure and deterministic.
- [ ] `npm test` covers: perfect retention, partial drop, `total === 0`, exact vs
      `id` match difference, severity-downgrade-as-dropped, `--json` output,
      threshold pass/fail exit codes, and CLI stdout.

## Non-goals

- **No fuzzy or semantic matching.** No edit-distance, embeddings, or LLM
  judgement; matching is byte-exact (or id-only). Even normalized-whitespace
  matching is out of v1 — determinism and simplicity win.
- **No reporting of *added* constraints.** Conformance measures retention of the
  original set; constraints that appear only in the compacted context are not
  counted or listed (a possible later `--show-added`, not now).
- **No schema change to #1** and **no change to `extract` (#2)**. Conformance
  consumes their existing outputs.
- **Read-only.** It never writes or modifies either context file, and it does not
  re-inject constraints — that is `pin`, a separate roadmap item.
- No config files, no network, no threshold/policy files — just the two paths and
  flags.

## Open questions (for the reviewer)

1. **Match default — the primary human gate.** Spec recommends `exact`
   (`id` + `text` + `severity`), with `--match id` as an opt-in. Confirm `exact`
   over id-only-by-default, and confirm that **`severity` should be part of the
   exact match** (so a `must`→`should` downgrade reads as dropped). If you'd
   rather compare `id` + `text` only, say so.
2. **`total === 0` score.** Spec defines it as `score: 1` (vacuously perfect —
   nothing to lose, and CI thresholds pass). The alternative is a `null`/"n/a"
   sentinel that callers must special-case. Confirm `1`.
3. **Below-threshold exit code.** Spec reserves exit `1` for operational/usage
   errors (unreadable file, bad flag) and uses a **distinct code `2`** for
   "ran fine but `score < threshold`," so CI can tell a broken tool from rotted
   constraints. Confirm `2`, or collapse both onto `1` if you prefer one failure
   code.
