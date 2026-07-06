# ConstraintGuard

[![CI](https://github.com/abhid1234/constraintguard/actions/workflows/ci.yml/badge.svg)](https://github.com/abhid1234/constraintguard/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

**Keep an AI agent's declared constraints alive across context compaction.** Zero dependencies.

When a long-running agent summarizes its history to fit the context window, its safety and policy constraints get silently dropped — measured violation rates jump from 0% to as high as 59% (arXiv 2606.22528, "ConstraintRot"). ConstraintGuard extracts declared constraints *before* compaction and re-pins them *after*, and ships a conformance suite so you can measure the risk on any harness.

```bash
cg validate constraints.json   # is this a well-formed constraint set?
cg extract session.md          # pull declared constraints out of a context
cg extract --harness claude-code session.jsonl  # …or straight from a Claude Code transcript
cg pin constraints.json ctx.md # re-inject constraints into a (compacted) context
cg conformance orig.md new.md  # score how well constraints survive compaction
cg otel constraints ctx.md     # map constraints to OpenTelemetry span attributes
```

The `otel` command emits a flat attribute object under the stable `constraintguard.*`
namespace (no OpenTelemetry SDK) — attach it to any span so "which constraints were
declared / dropped" shows up in your agent's trace.

Open format, dependency-free, cross-harness. Run the tests: `npm test`.

Reproduce the ConstraintRot drop on committed sample sessions: `npm run bench`. It
scores each session's original context against its compacted version with
`cg conformance` and prints a retention table plus the aggregate drop.

> Built by the Foundry software factory. Issues here are triaged, specced, implemented, reviewed and shipped by agents, with human approval at the gates.
