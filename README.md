# ConstraintGuard

[![CI](https://github.com/abhid1234/constraintguard/actions/workflows/ci.yml/badge.svg)](https://github.com/abhid1234/constraintguard/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

**Keep an AI agent's declared constraints alive across context compaction.** Zero dependencies.

When a long-running agent summarizes its history to fit the context window, its safety and policy constraints get silently dropped — measured violation rates jump from 0% to as high as 59% (arXiv 2606.22528, "ConstraintRot"). ConstraintGuard extracts declared constraints *before* compaction and re-pins them *after*, and ships a conformance suite so you can measure the risk on any harness.

```bash
cg validate constraints.json   # is this a well-formed constraint set?
cg extract session.md          # pull declared constraints out of a context
cg extract --harness claude-code session.jsonl  # …or straight from a Claude Code transcript
cg extract --harness codex rollout.jsonl        # …or from an OpenAI Codex CLI rollout
cg pin constraints.json ctx.md # re-inject constraints into a (compacted) context
cg conformance orig.md new.md  # score how well constraints survive compaction
cg otel constraints ctx.md     # map constraints to OpenTelemetry span attributes
```

The `otel` command emits a flat attribute object under the stable `constraintguard.*`
namespace (no OpenTelemetry SDK) — attach it to any span so "which constraints were
declared / dropped" shows up in your agent's trace.

## Dogfood: auto-pin across Claude Code compaction

ConstraintGuard exists for one failure — an agent's declared rules silently
vanish when a long session compacts its context. The `cg hook` commands close
that loop **automatically inside Claude Code**: on compaction they extract the
session's declared constraints; immediately after, they re-inject them into the
freshly compacted context. No glue script, no file to maintain — just two hooks.

Drop this into `~/.claude/settings.json` (all projects) or `.claude/settings.json`
(one project) — it is [`hooks/claude-code/settings.json`](hooks/claude-code/settings.json)
verbatim:

```json
{
  "hooks": {
    "PreCompact": [
      { "hooks": [ { "type": "command", "command": "cg hook pre-compact" } ] }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [ { "type": "command", "command": "cg hook session-start" } ]
      }
    ]
  }
}
```

- **`cg hook pre-compact`** (event `PreCompact`, no matcher) reads the hook JSON
  on stdin, extracts the session's declared constraints from its transcript, and
  caches them keyed by `session_id`. Repeated compactions **union** into the
  cache, so a constraint declared early survives every later compaction.
- **`cg hook session-start`** (event `SessionStart`, matcher `compact`) reads the
  cached set and returns it as `hookSpecificOutput.additionalContext` — a single
  `cg pin`-rendered ```` ```constraints ```` block — which Claude Code appends to
  the compacted context. It prints nothing when the session declared no
  constraints.

Both hooks are fail-safe: any error (unreadable transcript, malformed JSON,
missing cache) exits `0` with no output, so a hook can never block compaction or
a session start. The cache lives under the OS temp dir — nothing is written to
your repo.

If `cg` is not on `PATH` in the hook environment, use
`npx --no-install constraintguard hook …` or an absolute path in place of `cg`.

**Verify it:** declare a constraint in a `constraints` fence, force a compaction
with `/compact`, and confirm the block reappears in the next turn.

> Note: `SessionStart`'s `source` string after compaction (and whether it fires
> after *automatic* window-full compaction, not just `/compact`) depends on your
> Claude Code version. If re-injection doesn't fire, adjust the `matcher` — no
> code change is needed.

Open format, dependency-free, cross-harness. Run the tests: `npm test`.

Reproduce the ConstraintRot drop on committed sample sessions: `npm run bench`. It
scores each session's original context against its compacted version with
`cg conformance` and prints a retention table plus the aggregate drop.

> Built by the Foundry software factory. Issues here are triaged, specced, implemented, reviewed and shipped by agents, with human approval at the gates.
