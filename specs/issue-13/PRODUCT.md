# PRODUCT — Claude Code adapter: extract constraints from a session transcript

Issue: [#13](https://github.com/abhid1234/constraintguard/issues/13) · Depends on: #2 (`cg extract`, shipped)

## Problem / motivation

`cg extract` today reads a generic text/markdown context and lifts declared
constraints out of `constraints` fenced blocks (#2). But a *live* Claude Code
agent doesn't hand you a tidy markdown file — its session lives in the append-only
`.jsonl` transcripts under `~/.claude/projects/<slug>/`, where the operator's
instructions are buried among assistant turns, tool calls, tool results, and
thinking blocks. To point ConstraintGuard at a running agent's *actual* session
and get its current constraint set, we need a **Claude Code adapter**: a step
that reads a transcript, isolates the constraint-bearing text, and feeds it into
the existing `extract` logic. This is the first cross-harness adapter the roadmap
calls for; a Codex adapter follows the same pattern later.

## Recommended direction

Two genuine product decisions were flagged on the issue. Both are resolved here.

### Q1 — Constraint source scope: **`constraints` fences in the operator's (user-role) text**

The adapter scans the text of every **`user`** record in the transcript — both
plain-string `content` and `text`-type content blocks — concatenates it in
transcript order, and runs the existing `extractConstraints` over the result.
It does **not** limit itself to "the system prompt only," and it does **not**
scan literally everywhere in the session.

Why, concretely:

- **"System prompt only" isn't available.** Claude Code `.jsonl` transcripts do
  **not** persist the harness system prompt as its own record type (verified
  against real transcripts on this machine: record `type`s are `user`,
  `assistant`, `attachment`, `tool` I/O, `queue-operation`, `ai-title`,
  `last-prompt`, `pr-link` — there is no `system` record). The closest persisted
  analog to "the rules the operator gave the agent" is the operator's own turns,
  which are `user` records. Speccing "system prompt only" would define the
  adapter around a record that usually isn't there.
- **Constraints are *declared* by the operator, not the model.** A declared
  constraint is a rule someone imposes on the agent. In a transcript that is the
  `user` side. Assistant text can *restate* or *drift* from constraints but does
  not declare them, so including it invites the agent's own paraphrase into the
  authoritative set.
- **The fence keeps false positives near zero, but source matters.** Extraction
  is already opt-in via the ```` ```constraints ```` fence (#2), so scanning user
  text is safe. Crucially, we must **exclude tool results**: an agent that reads
  a file containing an illustrative ```` ```constraints ```` block (this very repo's
  `specs/` and `src/extract.js` docstring contain such examples) would otherwise
  have those example constraints extracted as if they were real. Restricting to
  user-authored text sidesteps that whole class of false positive.

So the adapter reads `user`-role text and ignores `assistant`, `tool_use`,
`tool_result`, `thinking`, `attachment`/`image`, and every non-message record
type. The ```` ```constraints ```` fence remains the explicit opt-in within that text.

> Open question left for the reviewer (below): whether to *also* include
> `assistant`-role text blocks. Default is user-only; it is a one-line change to
> widen if the reviewer prefers.

### Q2 — CLI shape: **a `--harness` flag on `extract`**

The surface is `cg extract --harness claude-code <transcript.jsonl>`, not a
separate `cg adapt` subcommand. `--harness <name>` selects an adapter that
pre-processes the raw file into the same plain-text context `extract` already
consumes; the extraction pipeline downstream is unchanged. The default,
`--harness text` (implied when the flag is omitted), is exactly today's
behavior, so #2 is untouched for existing users.

Why: it keeps one `extract` command and one mental model ("extract constraints
from a context, whatever produced it"), matches the roadmap's "small composable
operations," and adds the least surface area. A separate `cg adapt <harness>`
command would exist only to emit text that you then pipe into `extract` — an
extra command for a step the flag folds in. (For anyone who *does* want to see
the isolated text, a `--show-context`/debug affordance can live under the flag;
noted as a non-goal for v1.)

## Desired behavior

- `cg extract --harness claude-code path/to/session.jsonl` reads the transcript,
  isolates the operator's constraint-bearing text, runs the existing extractor,
  and prints the constraint set as pretty JSON to **stdout** — identical output
  contract to plain `cg extract`, so it composes the same way
  (`… | cg pin` (future), `> constraints.json`).
- The emitted set always passes `validateConstraintSet` (#1): unique ids, valid
  severities, non-empty text.
- **No constraints found** is a normal result, not an error: print `[]`, exit
  `0`, with a one-line note to **stderr** (same as #2).
- `--strict` continues to mean what it means for `extract`: the first malformed
  *constraint line* (or id conflict) becomes a non-zero exit. Malformed
  *transcript lines* (a corrupt `.jsonl` record) are a transcript-parsing
  concern, always tolerated with a stderr warning — a half-written last line in
  an append-only log must never crash the tool, even under `--strict`.
- An **unknown harness name** exits non-zero with a message listing the
  supported harnesses (`text`, `claude-code`).
- A **missing/unreadable file** exits non-zero with a clear message (as today).
- The library exposes the adapter as a pure function so programmatic callers can
  go transcript-string → constraint set without the CLI.

## Acceptance criteria

- [ ] `cg extract --harness claude-code <file.jsonl>` extracts every constraint
      declared in a ```` ```constraints ```` fence within `user`-role text, in
      transcript order, and prints the pretty-printed JSON set to stdout.
- [ ] Output always validates against `validateConstraintSet` (#1).
- [ ] A ```` ```constraints ```` block appearing **only** in an `assistant`
      message, a `tool_result`, a `thinking` block, or any non-`user` record is
      **not** extracted (proves scope + the tool-result false-positive is closed).
- [ ] Constraints split across two separate `user` turns are both extracted, in
      transcript order.
- [ ] Malformed / non-JSON transcript lines (including a truncated final line)
      are skipped with a stderr warning; valid records are still processed; the
      command does not crash, including under `--strict`.
- [ ] A transcript with no `constraints` fence → `[]`, exit `0`, stderr note.
- [ ] `--strict` still turns a malformed *constraint line* or id conflict into a
      non-zero exit (delegated to #2's `extractConstraints`).
- [ ] Omitting `--harness` (or `--harness text`) is byte-for-byte today's
      `cg extract` behavior — #2 has no regression.
- [ ] An unknown `--harness <name>` exits non-zero listing supported harnesses.
- [ ] A committed small sample-transcript fixture drives the tests.
- [ ] Zero runtime dependencies; the adapter is pure and deterministic (no I/O,
      clock, or randomness in the library function).
- [ ] `npm test` covers: happy path, scope exclusion (assistant/tool/thinking),
      multi-turn, malformed-line tolerance, no-constraints, unknown-harness, and
      the `--harness` CLI path.

## Non-goals

- **No new harnesses in this issue.** Codex (and others) reuse this pattern
  later; only `claude-code` ships here. The registry is built so adding one is a
  small, isolated change.
- **No auto-discovery of transcripts.** The user passes an explicit `.jsonl`
  path. Resolving `~/.claude/projects/<slug>/` from a cwd, picking the "current"
  session, or watching a live file are out of scope.
- **No changes to the constraint schema (#1) or to `extractConstraints`'s
  grammar (#2).** The adapter only produces the text that `extract` already
  understands.
- **No `constraints`-fence inference from prose, tool output, or model text.**
  The explicit fence remains the only marker; the adapter narrows *where* it is
  read, it does not add new detection.
- **No `--show-context` / debug dump of the isolated text in v1** (noted as a
  possible later nicety).
- **No merging across multiple transcripts** in one invocation (one file per run).

## Open questions (for the reviewer)

1. **Include `assistant`-role text too?** Default (recommended) is **user-role
   text only** — the operator declares constraints; assistant text can drift and
   widens false-positive surface. If you expect agents to (re)declare
   constraints in their own turns, we widen to user + assistant text blocks
   (still excluding tool I/O and thinking). One-line change; flag before
   implementation.
2. **Sidechain / subagent turns.** Transcripts mark subagent turns with
   `isSidechain: true`. Default is to treat their `user` text like any other. If
   you'd rather scope to the main thread only, we filter `isSidechain !== true`.
   Minor; call it if you have a preference.
