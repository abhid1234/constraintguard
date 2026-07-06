# TECH — Claude Code compaction hook (`cg hook pre-compact` / `cg hook session-start`)

Issue: [#22](https://github.com/abhid1234/constraintguard/issues/22) · Depends on: `extractFromHarness` (#13, `src/harness/index.js`), `pinConstraints` (#7, `src/pin.js`), `validateConstraintSet` (#1, `src/schema.js`)

## Approach

Add a single new command family, `cg hook <event>`, that adapts Claude Code's
hook protocol (JSON on stdin; optional JSON on stdout) to the constraint
operations we already ship. The reusable logic lives in a new **`src/hook.js`**
with injected I/O so it is unit-testable without touching the real filesystem;
`bin/cg.js` is the thin shell that wires in real `fs`/`os` and reads stdin.

- **`pre-compact`**: parse the stdin payload → read the file at `transcript_path`
  → `extractFromHarness('claude-code', raw)` → **union** the result into the
  per-session cache file → exit `0`. Emits no stdout (`PreCompact` has no
  additionalContext channel; its only job is to stash the set).
- **`session-start`**: parse the stdin payload → if `source !== 'compact'` exit
  `0` silently → load the cached set for `session_id` → if empty/missing, exit `0`
  silently → otherwise render `pinConstraints(set, '')` (a bare
  ```` ```constraints ```` block), wrap it in the `additionalContext` JSON, print
  to stdout, exit `0`.

Everything stays zero-dependency: `JSON.parse`, `node:fs`, `node:os`,
`node:path` only. The two shipped operations do the real work unchanged.

## The hook protocol we depend on (document at the top of `src/hook.js`)

- **`PreCompact` stdin** (fields we use): `session_id: string`,
  `transcript_path: string`, `hook_event_name: "PreCompact"`,
  `trigger: "manual" | "auto"`. No stdout is consumed by Claude Code for this
  event; exit code only.
- **`SessionStart` stdin** (fields we use): `session_id: string`,
  `hook_event_name: "SessionStart"`, `source: "startup" | "resume" | "clear" |
  "compact"`. **Stdout**, when it is JSON of the form
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`,
  is appended to the post-compaction context.
- **Failure contract**: a hook that exits non-zero (or prints malformed control
  JSON) can disrupt the session. Therefore **every** path in `src/hook.js`
  resolves to `{ exitCode: 0, stdout: '' }` on error, optionally with a `stderr`
  note. We never throw out of the command.

## Cache design

- **Location**: `path.join(os.tmpdir(), 'constraintguard', <safeSessionId>.json)`.
  `<safeSessionId>` = `session_id` with anything outside `[A-Za-z0-9._-]`
  replaced by `_` (defense against path traversal; real ids are UUIDs). The
  `constraintguard` dir is `mkdirSync(…, { recursive: true })` on write.
- **Format**: the JSON constraint set exactly as `extract`/`pin` produce/consume
  it (`Array<{ id, text, severity }>`), so `session-start` can `JSON.parse` it and
  hand it straight to `pinConstraints`.
- **Union on write** (`pre-compact`): load the existing cache (or `[]` if
  absent/corrupt), concatenate the newly-extracted set, then dedupe by `id`
  keeping the **first** occurrence's text/severity (same rule `extract` uses for
  id conflicts), and re-`validateConstraintSet` before writing. This is a few
  lines and makes the cache monotonic across a session.

## Files / functions to touch

- **`src/hook.js`** (new) — pure-ish core, I/O injected via a `deps` object so
  tests pass fakes:
  - `export function runPreCompact(stdin, deps)` where
    `deps = { readFileSync, readCache, writeCache }` (the latter two operate on a
    session key). Steps: `parsePayload(stdin)` → read `transcript_path` →
    `extractFromHarness('claude-code', raw, { onWarning })` →
    `unionById(readCache(session_id), extracted)` → `writeCache(session_id, merged)`.
    Returns `{ exitCode: 0, stdout: '' }`. Any thrown error is caught and
    downgraded to `{ exitCode: 0, stdout: '', stderr }`.
  - `export function runSessionStart(stdin, deps)` where
    `deps = { readCache }`. Steps: `parsePayload(stdin)` → if
    `source !== 'compact'` return silent → `set = readCache(session_id)` → if
    empty return silent → `block = pinConstraints(set, '')` →
    `additionalContext = INSTRUCTION + '\n\n' + block` →
    `stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })`.
    Returns `{ exitCode: 0, stdout }`.
  - Helpers: `parsePayload` (tolerant `JSON.parse`, returns `{}` on failure so
    downstream field reads just no-op), `unionById`, `safeSessionKey`,
    and the fixed `INSTRUCTION` string (e.g. *"The constraints below were
    declared earlier this session and must continue to hold after compaction:"*).
- **`bin/cg.js`** — add a `case 'hook': return cmdHook(rest);` in `main()`, and:
  - `cmdHook(args)` dispatches `pre-compact` / `session-start` / `-h`/`--help`;
    unknown mode → `fail(...)` with usage (mirrors `cmdOtel`).
  - Read **all of stdin** synchronously: `readFileSync(0, 'utf8')` (fd 0), which
    the repo already uses for `cg pin -`. Wrap in try/catch → empty string on
    error.
  - Build real `deps`: `readCache(id)`/`writeCache(id, set)` implemented with
    `os.tmpdir()` + `node:fs` per the cache design; `readFileSync` from `node:fs`.
  - Call the `src/hook.js` function, `process.stdout.write(result.stdout)` if
    non-empty, `process.stderr.write(result.stderr)` if present, and
    `process.exit(result.exitCode)` (always `0` here, but explicit).
  - Extend `USAGE` with:
    `cg hook pre-compact   # PreCompact: cache declared constraints (stdin: hook JSON)`
    and
    `cg hook session-start # SessionStart(compact): re-inject cached constraints`.
  - Import `pinConstraints`, `extractFromHarness` (already exported from
    `src/index.js`); no new exports strictly required, though re-exporting the two
    `runX` helpers from `src/index.js` is fine for programmatic callers.
- **`hooks/claude-code/settings.json`** (new) — the drop-in snippet (below).
- **`README.md`** — a short "Dogfood: auto-pin across Claude Code compaction"
  section: what it does, the snippet, and the verify recipe. *(README/doc edits
  are part of implementation, not this specs-only PR.)*
- **Tests**: `test/hook.test.js` (unit, injected `deps`) and
  `test/cli-hook.test.js` (child-process, JSON piped to stdin) — matching the
  repo's per-command test split (`cli-harness`, `cli-otel`, …).

## `settings.json` snippet (shape the implementer ships)

```json
{
  "hooks": {
    "PreCompact": [
      { "hooks": [ { "type": "command", "command": "cg hook pre-compact" } ] }
    ],
    "SessionStart": [
      { "matcher": "compact",
        "hooks": [ { "type": "command", "command": "cg hook session-start" } ] }
    ]
  }
}
```

If `cg` is not on `PATH` in the hook environment, the command becomes
`npx --no-install constraintguard hook …` (or an absolute path). The README notes
this; the snippet uses the bare `cg` form as the common case.

## Test plan (`npm test` → `node --test`)

Unit (`test/hook.test.js`, using injected `deps` — no real fs):
1. **pre-compact caches** — given a stdin payload and a fake `readFileSync`
   returning a transcript with a `constraints` fence in `user` text,
   `runPreCompact` calls `writeCache(session_id, set)` with the extracted set;
   `stdout` empty, `exitCode 0`.
2. **union across two compactions** — seed the fake cache with set A; a second
   `runPreCompact` extracting set B writes A ∪ B, deduped by id, A's text winning
   on id collision.
3. **session-start emits additionalContext** — fake cache holds a set;
   `runSessionStart` with `source: 'compact'` returns `stdout` that `JSON.parse`s
   to the expected `hookSpecificOutput` shape, and the `additionalContext`
   contains a ```` ```constraints ```` block.
4. **round-trip** — `extractConstraints` run over the `additionalContext` block
   reproduces the cached set (ids, order, severity) — the pin/extract inverse
   holds through the hook.
5. **silent paths** — `runSessionStart` returns empty stdout for: `source` ≠
   `compact`; missing cache; empty cached set.
6. **failure paths** — bad stdin (`"{"`), a `readFileSync` that throws
   (unreadable `transcript_path`), and a `writeCache` that throws each yield
   `{ exitCode: 0, stdout: '' }` — never a throw, never non-zero.
7. **no-constraints transcript** — `runPreCompact` over a fence-less transcript
   writes `[]` (or leaves cache empty); a following `runSessionStart` is silent.

CLI (`test/cli-hook.test.js`, child process piping stdin):
8. **end-to-end** — spawn `bin/cg.js hook pre-compact` with a payload whose
   `transcript_path` points at the existing
   `test/fixtures/claude-code-session.jsonl`, then `bin/cg.js hook session-start`
   with the same `session_id` and `source: 'compact'`; assert stdout parses to the
   additionalContext JSON and the block extracts back to the fixture's constraints.
   Use a per-test `TMPDIR`/temp dir override so the cache is isolated and cleaned.
9. **CLI silence** — `session-start` with `source: 'startup'` prints nothing,
   exits `0`.
10. **CLI unknown mode** — `cg hook bogus` exits non-zero with usage on stderr.

## Risks / edge cases / migrations

- **`SessionStart` source semantics (headline risk).** The precise `source`
  string after compaction, and whether `SessionStart` fires after *auto*
  compaction (not just `/compact`), are Claude-Code-version-dependent. Mitigation:
  the behavior is driven entirely by the `settings.json` matcher and a
  string compare in `runSessionStart`; if verification shows a different value, it
  is a snippet/constant change, not a redesign. **Verify against a live session
  during implementation** and record the confirmed value in the README. (PRODUCT
  open question #1.)
- **`session_id` continuity across compaction.** The design assumes the
  `SessionStart(compact)` payload carries the same `session_id` as the preceding
  `PreCompact` (so the cache key matches). This holds for in-session compaction;
  confirm during the live check. If it ever differs, fall back to a
  most-recent-cache-file strategy (note only; not implemented in v1).
- **Hook must never break the session.** Enforced by the catch-all
  exit-`0`/empty-stdout contract and covered by test #6. This is the single most
  important invariant.
- **Chained compactions losing early constraints.** Addressed by the union cache
  (PRODUCT); without it, an early constraint dropped from the transcript and not
  round-tripped via `additionalContext` would be lost on the second compaction.
- **`cg` not on PATH in the hook env.** Documented `npx`/absolute-path fallback in
  the README; not a code concern.
- **Reading stdin.** `readFileSync(0, 'utf8')` is already the repo's idiom (`cg
  pin -`); if stdin is empty/closed it yields `''`, which `parsePayload` turns
  into a silent no-op.
- **Large transcripts.** `readFileSync` + line split is O(size); fine for a CLI
  hook, same as the #13 adapter. Streaming is out of scope.
- **Migration**: purely additive — one new command family, one new source file,
  a snippet, a README section, and tests. No schema/data/behavior change to any
  existing command; omitting the hooks leaves everything as-is.

## Alternatives considered

- **Standalone shell/Node glue scripts under `hooks/claude-code/`** invoked from
  `settings.json` — more files to copy and keep in sync, and shell can't parse the
  hook JSON cleanly. Rejected in favor of `cg hook <event>` subcommands (PRODUCT).
- **Inject by rewriting `CLAUDE.md` / a context file** instead of
  `additionalContext` — mutates the user's repo, races other writers, and isn't
  guaranteed to be re-read post-compaction. Rejected; `additionalContext` is the
  purpose-built channel.
- **Overwrite the cache each compaction** instead of union — simpler but can drop
  early constraints across multiple compactions. Rejected as default (PRODUCT
  open question #3).
- **Project-local `.constraintguard/` cache** instead of `os.tmpdir()` — pollutes
  the repo and needs a gitignore entry for a file that only lives between two
  hooks. Rejected as default; offered as a reviewer option (PRODUCT open
  question #2).
- **A dedicated `cg pin --additional-context` / block-only pin flag** rather than
  `pinConstraints(set, '')` — unnecessary; pinning into an empty context already
  yields exactly the bare block, and the hook calls the library function directly.
  Rejected as extra surface.
