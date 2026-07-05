# ConstraintGuard — Roadmap

ConstraintGuard is a zero-dependency library + CLI that keeps an AI agent's
declared constraints alive across context compaction. Simplicity and portability
are the product: an open constraint format any harness can read, and small
composable operations over it.

## Direction (hold this line)
- **Zero runtime dependencies.** Node standard library only.
- **An open, portable JSON constraint format** — not a database, not a service.
- **Small composable operations** (validate / extract / pin / score) over one
  clear data model, exposed as both a library and a `cg` CLI.
- **Harness-neutral.** Works with any agent that produces a text context; no
  lock-in to a provider or framework.

## Near-term (aligned — welcome)
- The constraint schema + a validator (the foundation everything builds on).
- `extract` — pull declared constraints out of a context/transcript.
- `pin` — re-inject constraints into a post-compaction context.
- `conformance` — a ConstraintRot-style score of how well constraints survive.
- Cross-harness adapters (Claude Code, Codex) reading each harness's context.
- An OpenTelemetry mapping (constraint event → span attribute).

## Out of scope (for now)
- A hosted service, dashboard, or account system.
- Provider- or framework-specific SDK lock-in.
- General context management beyond constraints (summarization quality, RAG).
- Any runtime dependency.
