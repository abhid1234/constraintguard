# TECH — Claude Code adapter

Issue: [#13](https://github.com/abhid1234/constraintguard/issues/13) · Depends on: #2 (`extractConstraints` in `src/extract.js`), #1 (`validateConstraintSet`)

## Approach

Introduce a thin **harness adapter layer** that converts a harness-native
artifact into the same plain-text context `extract` already consumes, then reuse
`extractConstraints` unchanged. An adapter is a pure function
`(raw: string, opts) → string` that isolates the constraint-bearing text. A tiny
registry maps a harness name to its adapter; `text` is the identity adapter
(returns `raw` verbatim, i.e. today's behavior). The `claude-code` adapter parses
the `.jsonl` transcript line-by-line with `JSON.parse` (no markdown/JSON-stream
library — zero dependencies), selects the text of `user`-role records, and joins
it into one string that flows straight into the existing extractor. `bin/cg.js`
gains a `--harness <name>` option on the `extract` subcommand that runs the raw
file through the chosen adapter before `extractConstraints`. Everything stays
pure and deterministic: the adapter does no I/O, reads no clock, uses no
randomness, so the same transcript always yields the same set.

## `.jsonl` parsing contract (the core of this issue)

The transcript is an append-only JSON-lines log. The adapter must be maximally
tolerant of shape variety and partial writes.

1. **Split** `raw` on `/\r?\n/`. For each line:
   - Skip empty/whitespace-only lines.
   - `JSON.parse` inside a `try`. On failure, `warn(...)` (line number) and skip
     — **never throw**, even under `strict` (a truncated final line in a live
     log is expected, not a constraint error).
2. **Select records** whose top-level `type === 'user'` (v1 scope; see PRODUCT
   Q1). Robustness: also require `record.message` to be an object; ignore
   records without one.
3. **Pull text** from `record.message`:
   - If `message.content` is a **string**, use it directly.
   - If `message.content` is an **array**, take each block with
     `block.type === 'text'` and use `block.text` (a string); ignore every other
     block type (`tool_use`, `tool_result`, `image`, etc.). Defensive: skip
     blocks whose `text` isn't a string.
   - Optionally cross-check `message.role === 'user'` for extra safety; the
     top-level `type` is authoritative.
4. **Join** all collected strings in transcript order with `\n\n` separators
   (blank line between turns) so a `constraints` fence never accidentally welds
   onto adjacent text, and each fence is independently detectable by #2's
   line-based scanner.
5. **Hand off**: the joined string is returned as the isolated context. The CLI
   (or `extractFromHarness`) then calls `extractConstraints(context, opts)`.

Explicitly **excluded** from the text: `assistant`, `attachment`, `tool_use`,
`tool_result`, `thinking` blocks, and all non-message record types
(`queue-operation`, `ai-title`, `last-prompt`, `pr-link`, …). This is what closes
the tool-result false-positive (an agent reading a file that contains an example
```` ```constraints ```` block).

> If the reviewer widens Q1 to include assistant text, step 2 becomes
> `type === 'user' || type === 'assistant'` and step 3 is unchanged (still
> `text` blocks only). If sidechains are excluded (Q2), add
> `record.isSidechain !== true` to the filter. Both are one-line changes.

## Files / functions to touch

- **`src/harness/claude-code.js`** (new) — `export function claudeCodeToContext(raw, opts = {})`
  implementing the parsing contract above. Pure; returns a string. Accepts
  `opts.onWarning` (same signature as `extract`) for skipped-line reporting.
- **`src/harness/index.js`** (new) — the registry + dispatch:
  - `const ADAPTERS = { text: (raw) => raw, 'claude-code': claudeCodeToContext }`.
  - `export const HARNESSES = Object.keys(ADAPTERS)` (for usage/error text).
  - `export function adaptHarness(name, raw, opts)` — looks up the adapter,
    throws a clear `Error` naming supported harnesses on an unknown name, else
    returns `adapter(raw, opts)`.
  - `export function extractFromHarness(name, raw, opts)` — convenience:
    `extractConstraints(adaptHarness(name, raw, opts), opts)`; the programmatic
    one-call path.
  > A flat `src/harness.js` single-file module is an acceptable alternative; a
  > directory is chosen to anticipate the Codex adapter (roadmap) without a later
  > move. Note for the implementer, not a hard requirement.
- **`src/index.js`** — re-export `adaptHarness`, `extractFromHarness`, and
  `HARNESSES` alongside the existing exports.
- **`bin/cg.js`** — in `cmdExtract`, add `--harness <name>` parsing (takes the
  next argv as the value; default `'text'`). After reading the file, run
  `adaptHarness(harness, text, { onWarning })` to get the context, then the
  existing `extractConstraints(context, …)` path is unchanged. Update `USAGE`:
  `usage: cg extract [--strict] [--harness text|claude-code] <context-file>`.
  Unknown harness → `fail(...)` (exit 1) with the supported list. Keep the
  unknown-option guard from rejecting `--harness`.
- **`test/fixtures/claude-code-session.jsonl`** (new) — a small, committed sample
  transcript (below).
- **`test/harness-claude-code.test.js`** (new) — library-level `node --test`.
- **`test/cli.test.js`** — extend with a `--harness claude-code` CLI case (or a
  new `test/cli-harness.test.js`, matching the repo's per-command CLI test
  split, e.g. `cli-conformance.test.js`).

## Sample fixture (shape)

A handful of JSON-lines exercising every branch, e.g.:

- a `queue-operation` / `ai-title` record (non-message, must be ignored);
- a `user` record whose `message.content` is a **string** containing a
  ```` ```constraints ```` block with a `must` and a `should` line;
- an `assistant` record with `thinking` + `text` blocks, the `text` block
  containing a *decoy* ```` ```constraints ```` block that must **not** be
  extracted;
- a `user` record whose `message.content` is an **array** with a `tool_result`
  block holding another decoy fence (must be ignored) plus a real `text` block
  with one more constraint;
- a deliberately **truncated / invalid** final line to prove tolerance.

The test asserts the extracted set equals exactly the constraints from the two
real `user` text sources, in order, and that the decoys are absent.

## Test plan (`npm test` → `node --test`)

Library (`test/harness-claude-code.test.js`):
1. **Happy path** — fixture (or inline transcript) yields exactly the expected
   `{ id, text, severity }` set from `user` text, in transcript order; result
   re-validates with `validateConstraintSet`.
2. **String vs. array content** — a `user` record with string `content` and one
   with an array of blocks both contribute their `text`.
3. **Scope exclusion** — a `constraints` fence present only in an `assistant`
   text block, a `tool_result`, a `thinking` block, and a non-message record is
   **not** extracted.
4. **Multi-turn ordering** — constraints declared across two `user` turns appear
   both, in order.
5. **Malformed lines** — a corrupt/truncated line and a blank line are skipped
   with a warning; surrounding valid records still extract; no throw even with
   `{ strict: true }`.
6. **No constraints** — a transcript with no fence returns `[]`.
7. **Determinism** — running the adapter twice on the same input gives an
   identical string / set.
8. **Unknown harness** — `adaptHarness('nope', …)` throws an Error naming the
   supported harnesses.

CLI (`test/cli.test.js` or `test/cli-harness.test.js`):
9. **CLI happy path** — `bin/cg.js extract --harness claude-code <fixture>` via
   child process: JSON on stdout, exit `0`, stdout parses and re-validates,
   decoys absent.
10. **CLI unknown harness** — exits non-zero with the supported-harness message
    on stderr.
11. **CLI no-op default** — `extract <file>` and `extract --harness text <file>`
    produce identical output (no #2 regression).

## Risks / edge cases / migrations

- **False positives from tool output** — the headline risk, and the reason for
  the user-only scope. A file the agent read that contains an example
  `constraints` fence arrives as a `tool_result` block and is excluded.
  Regression-guarded by test #3.
- **Transcript format drift** — the `.jsonl` shape is Anthropic-internal and can
  change (new record types, content-block shapes). Mitigation: the adapter is
  *allow-list* by `type`/`block.type` and defensive on missing fields, so unknown
  shapes are silently ignored rather than crashing; the fixture pins the contract
  we support today.
- **Truncated / partial last line** — expected in an append-only live log;
  tolerated by the per-line `try/parse/skip` (test #5). Never fatal, even under
  `--strict`, which is scoped to constraint-line strictness only.
- **Wrong harness on a plain-markdown file** — every line fails `JSON.parse`, so
  the adapter yields empty text and the command prints `[]` with warnings. Add a
  guard: if the file is non-empty but *zero* records parsed, emit an extra
  stderr note ("no valid Claude Code transcript records found — is this a
  `.jsonl` transcript?") to avoid a silently-empty result being mistaken for "no
  constraints."
- **Large transcripts** — sessions can be many MB. `readFileSync` +
  `split('\n')` is O(size) and fine for a CLI; streaming is unnecessary
  complexity and out of scope (note only).
- **`--harness` value parsing** — `--harness` needs an argument; if it's the last
  token or the next token looks like a flag, `fail(...)` with usage. Keep the
  existing `unknown option` guard from swallowing the value.
- **No migration** — additive: new files, three new exports, one new CLI flag
  with a default that preserves current behavior. No schema or data change.

## Alternatives considered

- **Separate `cg adapt <harness>` subcommand** — a command whose only output is
  text you pipe into `extract`; more surface for a step the `--harness` flag
  folds in. Rejected (see PRODUCT Q2); a debug `--show-context` can cover the
  "just show me the isolated text" case later.
- **"System prompt only" scope** — undefinable here: Claude Code transcripts
  don't persist a `system` record, so this would target a record that usually
  isn't present. Rejected in favor of operator (`user`) text.
- **Scan all message text including assistant/tool/thinking** — maximizes recall
  but reintroduces the tool-result false positive and lets model paraphrase into
  the authoritative set. Rejected as the default; assistant text is left as a
  reviewer-gated widening (PRODUCT Q1).
- **Depend on a JSONL/stream-parsing package** — violates the zero-dependency
  line; `split` + `JSON.parse` per line is a few lines of standard library.
  Rejected.
- **Flat `src/harness.js` vs. `src/harness/` directory** — both fine; directory
  chosen to seat the future Codex adapter without a later move. Non-blocking.
