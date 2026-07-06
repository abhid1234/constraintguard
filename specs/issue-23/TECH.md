# TECH — Codex adapter

Issue: [#23](https://github.com/abhid1234/constraintguard/issues/23) · Follows: #13 (`src/harness/` layer + `claude-code.js`), #2 (`extractConstraints`), #1 (`validateConstraintSet`)

## Approach

Add a second adapter to the harness layer #13 built. An adapter is a pure
function `(raw: string, opts) → string` that isolates the constraint-bearing
text; the registry in `src/harness/index.js` maps a name to its adapter. The new
`codex` adapter parses the Codex rollout `.jsonl` line-by-line with `JSON.parse`
(no stream/JSON library — zero dependencies), selects the operator's turns
(`response_item` message records with `role === "user"`), joins their text into
one string, and hands it to the unchanged `extractConstraints`. Structurally it
is the Claude Code adapter with a different record filter — the parse loop,
tolerance rules, blank-line join, and warning hooks are identical, so it inherits
#13's determinism (no I/O, no clock, no randomness). `bin/cg.js` needs **no**
logic change (it already threads `--harness`/`HARNESSES`); only its hard-coded
usage string gains `codex`.

## Codex rollout `.jsonl` parsing contract (the core of this issue)

A rollout is an append-only JSON-lines log at
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. Every line is an
envelope `{ timestamp, type, payload }`. Verified against the Codex source
(`codex-rs/rollout/src/recorder_tests.rs`): line `type`s include `session_meta`
(first line), `response_item`, and `event_msg`; a `response_item` message payload
is `{ "type": "message", "role": "user"|"assistant", "content": [ { "type":
"input_text"|"output_text", "text": "…" } ] }`.

1. **Split** `raw` on `/\r?\n/`. For each line:
   - Skip empty / whitespace-only lines.
   - `JSON.parse` inside a `try`. On failure, `warn(...)` with the 1-based line
     number and skip — **never throw**, even under `strict` (a truncated final
     line in a live append-only log is expected, not a constraint error).
2. **Select records** where **all** hold (this is the whole allow-list):
   - `record.type === "response_item"`
   - `record.payload` is an object with `payload.type === "message"`
   - `payload.role === "user"`
   Everything else is ignored: assistant messages, `function_call`,
   `function_call_output` / tool output, `reasoning`, `ghost_snapshot`,
   `compacted`, all `event_msg` lines (incl. `user_message`), `session_meta`,
   and any unknown shape.
3. **Pull text** from `payload.content`:
   - If `content` is an **array**, take each block with
     `block.type === "input_text"` and use `block.text` (a string); ignore other
     block types. Defensive: skip a block whose `text` isn't a string.
   - If `content` is a **string** (defensive; Codex uses arrays), use it
     directly. Mirrors the Claude Code adapter's string/array handling.
4. **Join** all collected strings in rollout order with `\n\n` (blank line
   between turns) so a `constraints` fence never welds onto adjacent text and each
   fence stays independently detectable by #2's line scanner.
5. **Empty-input guard**: if the file is non-empty but yielded zero parseable
   records, `warn('no valid Codex rollout records found — is this a .jsonl
   rollout?')`, so a silently-empty result isn't mistaken for "no constraints"
   (parallels #13).
6. **Hand off**: return the joined string; the CLI (or `extractFromHarness`) then
   calls `extractConstraints(context, opts)` unchanged.

**No double-counting.** Because step 2 accepts only `response_item` messages, the
`event_msg` `user_message` echo of the same text is never scanned, so a
constraint the operator typed once is extracted once — without relying on #2's
exact-duplicate dedup.

## Files / functions to touch

- **`src/harness/codex.js`** (new): `export function codexToContext(raw, opts = {})`.
  Same signature/shape as `claudeCodeToContext`: string-type guard on `raw`,
  `opts.onWarning` hook (default noop), the loop above. Header comment documents
  the record filter and the rollout location, matching `claude-code.js`'s style.
- **`src/harness/index.js`**: `import { codexToContext } from './codex.js';` and
  add `codex: codexToContext,` to the `ADAPTERS` map. `HARNESSES` and
  `adaptHarness`/`extractFromHarness` pick it up automatically.
- **`src/index.js`**: no change needed — the barrel exports the harness layer
  by `adaptHarness` / `extractFromHarness` / `HARNESSES` (not adapters by name,
  matching #13, which does not export `claudeCodeToContext`). The `codex` adapter
  is reached via `extractFromHarness('codex', …)` / `adaptHarness('codex', …)`.
- **`bin/cg.js`**: update the hard-coded `USAGE` line
  `'usage: cg extract [--strict] [--harness text|claude-code] <context-file>'`
  → `…text|claude-code|codex…`. No other CLI change (the `--harness` parsing and
  `HARNESSES`-driven error text already handle a new name).
- **`test/fixtures/codex-session.jsonl`** (new): a small hand-authored rollout
  (see below).
- **`test/harness-codex.test.js`** (new): library-level tests, mirroring
  `test/harness-claude-code.test.js`.
- **`test/cli-harness.test.js`**: add a `--harness codex` case against the
  fixture (spawn `bin/cg.js`, assert stdout JSON + exit 0), alongside the
  existing claude-code CLI case.
- **`README.md`** (optional, minor): add a `cg extract --harness codex …` line to
  the usage block next to the claude-code example.

## Fixture (`test/fixtures/codex-session.jsonl`)

Hand-authored (do not commit a real session — no PII). One record per line:

1. `session_meta` first line (`type:"session_meta"`) — must be ignored.
2. `response_item` user message, `input_text`, with a real fence declaring e.g.
   `must [no-pii]: Never leak personal data.` and `should: Keep replies concise.`
3. `response_item` assistant message (`output_text`) with a **decoy** fence
   (`decoy-assistant`) — must be excluded.
4. `response_item` `function_call_output` whose output text embeds a **decoy**
   fence (`decoy-tool`, simulating a file the agent read) — must be excluded.
5. `response_item` `reasoning` item containing a **decoy** fence
   (`decoy-reasoning`) — must be excluded.
6. `event_msg` `user_message` that **duplicates** the operator text from record 2
   — must not double-count.
7. A second `response_item` user message declaring `must [audit-log]: …`
   (multi-turn ordering).
8. A truncated final line (intentionally invalid JSON) — must be skipped with a
   warning, no crash.

Expected happy-path extraction: exactly `no-pii` (must), `keep-replies-concise`
(should), `audit-log` (must), in that order.

## Test plan (`npm test`, `node --test`)

Mirror `test/harness-claude-code.test.js`:

- **happy path** — fixture yields exactly `[no-pii, keep-replies-concise,
  audit-log]` in order; result passes `validateConstraintSet`.
- **scope exclusion** — no extracted id starts with `decoy` (assistant /
  tool-output / reasoning fences all excluded).
- **no double-count** — the record-2 constraint duplicated in the record-6
  `event_msg` appears exactly once.
- **string + array content** both contribute (defensive string path).
- **multi-turn** — constraints in two separate user turns extracted in order.
- **assistant-only fence** → `[]`.
- **malformed / blank lines** skipped with an `onWarning` message; a valid
  record after a bad line still extracted; **no throw under `strict`**.
- **non-rollout file** (plain markdown) → `''` from the adapter + a "not a
  .jsonl rollout?" warning.
- **no-constraints rollout** → `[]`.
- **determinism** — same rollout → identical isolated context.
- **unknown-harness** still throws listing `text`, `claude-code`, `codex`.
- **CLI** (`test/cli-harness.test.js`) — `cg extract --harness codex <fixture>`
  exits 0 and prints the expected JSON set; regression check that omitting
  `--harness` is unchanged.

## Risks / edge cases / migrations

- **Rollout schema drift.** Codex's on-disk format has changed across versions
  (the issue's open question). The allow-list-by-shape design fails safe: an
  unrecognized record shape yields no text (with the "not a rollout?" warning)
  rather than a crash or a false positive. If a future Codex version renames
  `response_item`/`message`/`input_text`, the filter is the single place to
  update. Fixture + tests pin the shape this spec targets.
- **Injected first-message wrappers.** The first user `response_item` carries
  Codex-injected `<user_instructions>` (AGENTS.md) and `<environment_context>`.
  These are harmless: only a ```` ```constraints ```` fence inside them is
  extracted, which is the desired behavior for AGENTS.md-declared rules
  (PRODUCT Q1). No stripping in v1.
- **Double-count avoidance** hinges on excluding `event_msg`; covered by a
  dedicated test so a future "also scan event_msg" change can't silently
  regress it.
- **No migration.** Purely additive — one new file, one registry line, one usage
  string. `--harness text` and `--harness claude-code` are byte-for-byte
  unchanged; zero new dependencies.

## Alternatives considered

- **Scan `event_msg`/`user_message` instead of `response_item`** — rejected:
  it is a UI echo, flat (no structured content), and coexists with the
  `response_item` message, so using it (or both) double-counts.
- **A separate `cg adapt codex` subcommand** — rejected (settled in #13): the
  `--harness` flag already folds the pre-processing step into `extract`; a new
  subcommand adds surface for no gain.
- **Strip `<user_instructions>`/`<environment_context>` wrappers** — deferred:
  the fence opt-in already makes the wrappers inert; stripping is an optional
  refinement, flagged as PRODUCT Q1, not needed for a correct v1.
- **Auto-discover the latest rollout under `~/.codex/sessions/`** — rejected as
  out of scope (same as #13): keep the adapter a pure `(raw)→string` with no I/O;
  path resolution can be a later, separate convenience.
