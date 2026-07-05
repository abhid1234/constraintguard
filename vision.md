# ConstraintGuard — Vision

Every long-running agent has rules it must not forget — safety limits, policy,
task constraints. Today those rules silently evaporate when the agent compacts
its context to fit the window. ConstraintGuard makes forgetting them impossible:
declare a constraint once, and it survives every compaction, on any harness.

The whole thing should be something a person can read end-to-end in an afternoon
and trust completely: one open JSON format for a constraint, a handful of pure
operations over it, and a conformance score that proves it works. No server, no
dependencies, no lock-in. If a change adds a service or a dependency, or reaches
beyond constraints into general context management, it is probably out of scope.
