# PRODUCT — Claude Code compaction hook: auto-extract on compact, auto-pin after (dogfood)

Issue: [#22](https://github.com/abhid1234/constraintguard/issues/22) · Depends on: #2 (`cg extract`, shipped), #7 (`cg pin`, shipped), #13 (`--harness claude-code` adapter, shipped) · Motivated by [#3](https://github.com/abhid1234/constraintguard/issues/3)

## Problem / motivation

ConstraintGuard exists for exactly one failure: an agent's declared rules
silently vanish when a long session compacts its context (#3). We now have every
piece to close that loop — `extract` pulls declared constraints out of a Claude
Code transcript (#13), `pin` re-injects them (#7) — but a user still has to run
them by hand at the right moment. This issue wires the two operations into
Claude Code's own hook system so the loop closes **automatically**: on
compaction, extract the session's declared constraints; immediately after,
re-inject them. Shipping this makes ConstraintGuard self-applying — it is the
dogfood story, and the most direct answer to #3.

## Recommended direction

Ship a **drop-in Claude Code hook bundle** driven by two new `cg` subcommands
that do the stdin/JSON plumbing, so the user's `settings.json` is a small,
copy-pasteable snippet and no per-user glue script is needed.

Two ambiguities were flagged on the issue. Both are resolved below.

### Q1 — Hook events + payload shape: **`PreCompact` (extract) + `SessionStart` matched to `compact` (pin)**

- **`PreCompact`** fires just before Claude Code compacts. Its stdin JSON carries
  `session_id`, `transcript_path` (the live `.jsonl`), `hook_event_name`, and
  `trigger` (`"manual"` | `"auto"`). The hook runs
  `cg extract --harness claude-code <transcript_path>` and **caches** the
  resulting constraint set keyed by `session_id`, so the post-compaction hook can
  find it. Register it with **no matcher** (both `manual` and `auto` compaction).
- **`SessionStart`** fires when a session starts/resumes/continues; its stdin
  JSON carries `session_id`, `transcript_path`, `hook_event_name`, and a `source`
  (`"startup"` | `"resume"` | `"clear"` | `"compact"`). We register it with
  **matcher `compact`** so it only acts right after a compaction. It reads the
  cached set for that `session_id` and re-emits it.

### Q2 — Where to inject: **`SessionStart` `additionalContext` (the hook's own output channel)**

The post-compaction hook returns the constraints as
`hookSpecificOutput.additionalContext` in its JSON stdout. Claude Code appends
that string to the freshly compacted context, so the constraints are present in
the very first turn after compaction — no user file is touched, no path is
assumed, and it works in any project. The injected text is a single
`cg pin`-rendered ```` ```constraints ```` block (explicit `[id]` form, so it is
itself re-extractable) preceded by one short instruction line.

Rejected for injection: **rewriting a context file / `CLAUDE.md`** (mutates the
user's repo, races other writers, and isn't guaranteed to be read post-compact);
**printing plain stdout without the JSON wrapper** (works, but `additionalContext`
is the documented, structured channel and lets us stay silent when there is
nothing to inject).

### Delivery shape: **`cg hook <event>` subcommands, not standalone glue scripts**

The engine is two subcommands — `cg hook pre-compact` and
`cg hook session-start` — each of which reads the hook JSON on **stdin**, does
its work, and (for `session-start`) writes the `additionalContext` JSON to
**stdout**. The `settings.json` snippet simply calls them. This keeps everything
in the one zero-dependency binary users already have, is unit-testable by piping
JSON to stdin, and matches the repo's "small composable commands" line. A folder
of per-user shell scripts was rejected: it adds files to copy, a second thing to
keep in sync, and shell JSON-parsing — all of which the subcommand removes.

## Desired behavior

**On compaction (`PreCompact`):**
- `cg hook pre-compact` reads the hook JSON on stdin, extracts the session's
  declared constraints from `transcript_path` via the `claude-code` adapter, and
  writes them to a per-session cache file keyed by `session_id`.
- The cache is **cumulative across the session**: each `PreCompact` unions the
  newly-extracted set into whatever was cached before (dedupe by `id`, keep the
  first-seen text on conflict — mirroring `extract`'s id-conflict rule). This is
  what lets constraints survive **repeated** compactions in one session, even if
  the re-injected block isn't itself re-extractable on the next pass.
- If no constraints are found, the cache is left as-is (or written empty); this
  is a normal outcome, not an error.

**After compaction (`SessionStart`, `source == "compact"`):**
- `cg hook session-start` reads the hook JSON on stdin, loads the cached set for
  `session_id`, and prints
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext": <block>}}`
  to stdout, where `<block>` is a short instruction line plus the `cg pin`-rendered
  ```` ```constraints ```` block.
- If there is **no cache** for the session or it holds an empty set, the hook
  prints **nothing** and exits `0` (no noise on a session that never declared a
  constraint).

**Always (both hooks):**
- A hook must **never break the session**. Any failure — unreadable transcript,
  malformed hook JSON, missing cache dir, extract/pin error — results in exit
  `0` with no stdout (an optional one-line `stderr` note for debugging). Hooks do
  not block compaction or startup on error.
- Zero runtime dependencies; Node standard library only.

**The bundle a user installs:**
- A `settings.json` snippet (drop into `~/.claude/settings.json` for all projects
  or `.claude/settings.json` for one) registering the two hooks.
- A short **README** section explaining install, what each hook does, and how to
  verify it (declare a constraint in a `constraints` fence, force a compaction
  with `/compact`, confirm the block reappears).

## Acceptance criteria

- [ ] `cg hook pre-compact` reads a `PreCompact` payload on stdin, runs
      `extractFromHarness('claude-code', …)` over the file at `transcript_path`,
      and writes the constraint set to a cache file keyed by `session_id`.
- [ ] Repeated `pre-compact` calls in the same session **union** into the cache
      (dedupe by `id`, first-seen text wins); constraints from an earlier
      compaction are still present after a later one.
- [ ] `cg hook session-start` with `source == "compact"` reads the cached set and
      prints valid JSON whose `hookSpecificOutput.additionalContext` contains the
      `cg pin`-rendered ```` ```constraints ```` block (explicit `[id]` form) for
      that session, prefixed by one instruction line.
- [ ] `session-start` with **no cache**, an **empty** cached set, or any
      `source` other than `compact` prints nothing and exits `0`.
- [ ] The injected `additionalContext` block round-trips: feeding it back through
      `cg extract` reproduces the cached set (same ids, order, severity) — proving
      the pin/extract inverse (#7) still holds through the hook.
- [ ] **No constraints declared** anywhere in the session ⇒ `pre-compact` caches
      nothing and `session-start` emits nothing; both exit `0`.
- [ ] Every hook failure path (bad stdin JSON, missing/unreadable
      `transcript_path`, un-writable cache dir) exits `0` and prints nothing to
      stdout, so it cannot block compaction or a session start.
- [ ] The committed `settings.json` snippet, pasted verbatim, registers
      `PreCompact` (no matcher) and `SessionStart` (matcher `compact`) to invoke
      the two subcommands.
- [ ] Zero runtime dependencies; the cache path derives from Node's `os.tmpdir()`
      (no repo pollution, no new gitignore entry).
- [ ] `npm test` covers: pre-compact caches the extracted set; union across two
      pre-compact calls; session-start emits valid additionalContext JSON;
      round-trip of the injected block; empty/no-cache/non-compact silence; each
      failure path exits `0` with empty stdout; and the CLI stdin path end-to-end.

## Non-goals

- **No new library operation.** This composes the shipped `extract` (#2/#13) and
  `pin` (#7); it adds CLI plumbing and a bundle, not a new constraint operation.
- **No other harnesses.** Codex and friends get their own hook bundles later,
  reusing this pattern. Only Claude Code ships here.
- **No auto-discovery or watching.** The hooks act on the `transcript_path` and
  `session_id` Claude Code hands them; nothing scans `~/.claude/projects/` or
  watches files.
- **No constraint editing/retraction semantics.** The cache only grows within a
  session; there is no "remove this constraint" syntax (out of scope for #22).
- **No global constraint store or cross-session persistence.** The cache is
  per-session and disposable (tmp dir); it is a hand-off between the two hooks in
  one session, not a database.
- **No config surface** (thresholds, custom instruction text, alternate injection
  targets) in v1 — sensible fixed behavior; configurability is a later issue.
- **No changes to the schema (#1), `extract` grammar (#2), the adapter (#13), or
  `pin` (#7).**

## Open questions (for the reviewer)

1. **Exact `SessionStart` source string / whether it fires after *auto*
   compaction.** This spec targets `source == "compact"`. The precise string and
   whether `SessionStart` reliably fires after an *automatic* (window-full)
   compaction — versus only `/compact` — depends on the installed Claude Code
   version and should be **verified against a live session during implementation**
   (see TECH "Risks"). If auto-compaction routes differently, the fix is a matcher
   change in the snippet, not a code change. Recommended default stands.
2. **Cache location: `os.tmpdir()` (recommended) vs. project-local
   `.constraintguard/`.** Tmp keeps the repo clean and needs no gitignore, at the
   cost of being cleared on reboot (fine — the cache only lives between two hooks
   in one session). If you'd rather the cache be inspectable next to the project,
   we switch to `$CLAUDE_PROJECT_DIR/.constraintguard/` and add a gitignore line.
   Minor; call it if you have a preference.
3. **Cumulative (union) cache vs. overwrite each compaction.** Recommended is
   union, so constraints survive *multiple* compactions in one session regardless
   of whether the injected block round-trips. Overwrite is simpler but risks
   losing an early constraint after a second compaction. Flag if you prefer the
   simpler overwrite.
