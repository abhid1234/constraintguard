# PRODUCT — Codex adapter: extract constraints from a Codex session

Issue: [#23](https://github.com/abhid1234/constraintguard/issues/23) · Follows: #13 (Claude Code adapter, shipped) · Depends on: #2 (`cg extract`, shipped)

## Problem / motivation

`cg extract --harness claude-code` (#13) can now point ConstraintGuard at a
*live* Claude Code agent's transcript. The roadmap calls for the same for
**Codex** ("Cross-harness adapters (Claude Code, Codex) reading each harness's
context"). Like Claude Code, an OpenAI Codex CLI session doesn't hand you a tidy
markdown file — it persists an append-only `.jsonl` **rollout** under
`~/.codex/sessions/YYYY/MM/DD/`, where the operator's instructions sit among
assistant turns, reasoning, tool calls, and tool output. To get a live Codex
agent's current constraint set we add a `codex` adapter that reads a rollout,
isolates the operator's constraint-bearing text, and feeds it into the existing
`extract` logic — reusing the harness-adapter layer #13 built.

## Recommended direction

The issue flags one open decision — *the Codex transcript format/location to
target*. It is resolved here from the Codex source (the `codex-rollout` crate),
so the implementation is a single pass.

### The format: Codex rollout `.jsonl`, `response_item` message records, `role: "user"`

A Codex rollout is JSON-lines. Every line is an envelope
`{ "timestamp": …, "type": <line-type>, "payload": { … } }`. Line types include
`session_meta` (always the first line), `response_item` (the model-visible
conversation items), and `event_msg` (UI-layer events). The operator's own turns
are **`response_item`** lines whose `payload` is an OpenAI Responses-API message:

```json
{"timestamp":"…","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"…the operator's text…"}]}}
```

The adapter selects exactly those records — `type === "response_item"` **and**
`payload.type === "message"` **and** `payload.role === "user"` — pulls the
`text` of each `input_text` content block, concatenates them in rollout order,
and runs the existing `extractConstraints` over the result. The ```` ```constraints ````
fence (#2) remains the explicit opt-in *within* that text. This mirrors the
Claude Code adapter exactly (role-filtered message records, typed content
blocks, blank-line join), so the two adapters are near-identical.

**Everything else is excluded**, which is what closes the tool-result / decoy
false positives:

- **assistant** messages (`payload.role === "assistant"`, `output_text` blocks) —
  the model restates/drifts, it does not *declare*.
- **tool output** (`payload.type === "function_call_output"`, `local_shell_call`
  output, etc.) — a file the agent read that happens to contain an example
  ```` ```constraints ```` block must never be extracted (same guard as #13's
  tool-result exclusion).
- **reasoning** items (`payload.type === "reasoning"`) — the model's private
  chain of thought.
- **`event_msg` lines**, including `payload.type === "user_message"`. This is a
  UI-layer echo of the same operator text that already appears as a
  `response_item` message; scanning both would **double-count** every declared
  constraint. We target the canonical model-visible `response_item` only.
- **`session_meta`** and every other non-message line type.

Why `response_item` message records and *not* `event_msg` `user_message`: the
`response_item` stream is the exact conversation the model sees — the text the
declared constraints actually govern — and it carries structured content blocks,
whereas `event_msg` `user_message` is a flat UI echo that would duplicate it.
Picking one representation keeps the extracted set free of spurious duplicates.

> Note (a feature, not a bug): Codex injects the operator's `AGENTS.md` and
> environment context into the first `response_item` user message. A
> ```` ```constraints ```` fence an operator puts in `AGENTS.md` therefore flows
> naturally into the extracted set — which is exactly where standing rules
> belong.

### CLI shape: reuse `--harness`, add `codex`

The surface is `cg extract --harness codex <rollout.jsonl>`. No new subcommand,
no new flag — `codex` is a one-line entry in the existing adapter registry
(`src/harness/index.js`) that #13 built for precisely this. Default behavior
(`--harness text`) is untouched.

## Desired behavior

- `cg extract --harness codex path/to/rollout.jsonl` reads the rollout, isolates
  the operator's (`response_item` / `role: "user"`) text, runs the existing
  extractor, and prints the constraint set as pretty JSON to **stdout** —
  identical output contract to plain `cg extract` and to `--harness claude-code`,
  so it composes the same way (`… | cg pin`, `> constraints.json`).
- The emitted set always passes `validateConstraintSet` (#1): unique ids, valid
  severities, non-empty text.
- **No constraints found** is a normal result: print `[]`, exit `0`, one-line
  stderr note (same as #2 / #13).
- `--strict` keeps its #2 meaning — the first malformed *constraint line* or id
  conflict is a non-zero exit. Malformed *rollout lines* (a corrupt or truncated
  `.jsonl` record in a live, append-only log) are always tolerated with a stderr
  warning and never crash the tool, **even under `--strict`** (identical to #13).
- A non-empty file that yields zero parseable rollout records warns that it may
  not be a Codex rollout (parallels #13's "is this a .jsonl transcript?" guard).
- An **unknown harness name** exits non-zero listing the supported harnesses
  (now `text`, `claude-code`, `codex`).
- A **missing/unreadable file** exits non-zero with a clear message (as today).
- The library exposes the adapter through the existing harness surface
  (`extractFromHarness('codex', …)` / `adaptHarness('codex', …)`) so programmatic
  callers go rollout-string → constraint set without the CLI.

## Acceptance criteria

- [ ] `cg extract --harness codex <rollout.jsonl>` extracts every constraint
      declared in a ```` ```constraints ```` fence within `response_item`
      `role: "user"` message text, in rollout order, and prints the
      pretty-printed JSON set to stdout.
- [ ] Output always validates against `validateConstraintSet` (#1).
- [ ] A ```` ```constraints ```` block appearing **only** in an assistant
      message, a `function_call_output` (tool output), a `reasoning` item, or an
      `event_msg` line is **not** extracted (proves scope, the tool-output false
      positive, and the no-double-count guard).
- [ ] A constraint that appears in **both** a `response_item` user message and
      its duplicate `event_msg` `user_message` echo is extracted **once**.
- [ ] Constraints split across two separate `response_item` user turns are both
      extracted, in rollout order.
- [ ] Both array content (`[{type:"input_text", text:…}]`) and a plain-string
      `content` (defensive) contribute their text.
- [ ] Malformed / non-JSON rollout lines (including a truncated final line) are
      skipped with a stderr warning; valid records are still processed; the
      command does not crash, including under `--strict`.
- [ ] A rollout with no `constraints` fence → `[]`, exit `0`, stderr note.
- [ ] `--strict` still turns a malformed *constraint line* or id conflict into a
      non-zero exit (delegated to #2's `extractConstraints`).
- [ ] Omitting `--harness` (or `--harness text`) is byte-for-byte today's
      `cg extract` behavior — #2 has no regression.
- [ ] An unknown `--harness <name>` exits non-zero listing supported harnesses
      (including `codex`).
- [ ] A committed small sample Codex-rollout fixture drives the tests.
- [ ] Zero runtime dependencies; the adapter is pure and deterministic (no I/O,
      clock, or randomness in the library function).
- [ ] `npm test` covers: happy path, scope exclusion (assistant / tool-output /
      reasoning / event_msg), no-double-count, multi-turn, string-vs-array
      content, malformed-line tolerance, no-constraints, unknown-harness, and the
      `--harness codex` CLI path.

## Non-goals

- **No auto-discovery of rollouts.** The user passes an explicit `.jsonl` path.
  Resolving `~/.codex/sessions/YYYY/MM/DD/`, picking the "latest"/"current"
  rollout, or watching a live file are out of scope (same stance as #13).
- **No changes to the constraint schema (#1) or to `extractConstraints`'s
  grammar (#2).** The adapter only produces the text `extract` already
  understands.
- **No new fence inference.** The explicit ```` ```constraints ```` fence stays the
  only marker; the adapter narrows *where* it is read, it adds no new detection.
- **No merging across multiple rollouts** in one invocation (one file per run).
- **No `event_msg`/`user_message` scanning.** Deliberately excluded to avoid
  double-counting the operator's text (see direction). Revisit only if a Codex
  version is found that omits `response_item` user messages.
- **No support for pre-`session_meta` / legacy rollout layouts** beyond
  best-effort tolerance — the adapter allow-lists by record shape, so an
  unrecognized older shape simply yields no records (with the "not a rollout?"
  warning), it does not crash.

## Open questions (for the reviewer)

1. **Include `AGENTS.md`-injected instructions?** They already arrive inside the
   first `response_item` user message, so a ```` ```constraints ```` fence in
   `AGENTS.md` is extracted for free. Recommended: **keep** (that is where
   standing operator rules live). Flag only if you'd rather strip the injected
   `<user_instructions>` / `<environment_context>` wrappers — a small, optional
   refinement, not required for a correct v1.
2. **`event_msg` as a fallback source?** Default (recommended) targets
   `response_item` user messages only and ignores `event_msg` to avoid
   double-counting. If a Codex build is found that persists user text *only* as
   `event_msg`/`user_message` and not as a `response_item` message, we would add
   it as a de-duplicated fallback. One-line change; call it if you have a
   preference.
