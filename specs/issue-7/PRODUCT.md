# PRODUCT — `cg pin`: re-inject constraints so they survive compaction

Issue: [#7](https://github.com/abhid1234/constraintguard/issues/7) · Depends on: #1 (constraint schema + validator), #2 (`cg extract`)

## Problem / motivation

Constraints silently evaporate when an agent compacts its context to fit the
window — that is the exact failure ConstraintGuard exists to prevent, and `pin`
is the fix. After a context has been summarized, `cg pin` writes a fresh
`constraints` fenced block back into it so the rules are present again, in a
form the rest of the toolchain already understands. The block must round-trip:
what `pin` writes, `cg extract` (#2) must read back **exactly** — same
constraints, same ids, same order — so `pin` and `extract` are inverses and the
constraint set is never quietly corrupted on the way through.

## Recommended direction

Two product decisions were flagged on the issue. Both are resolved here toward
the simplest rule that guarantees the round-trip and idempotency; each is also
raised as an open question for the reviewer to confirm.

**1. Injection point → the top of the context.** The emitted `constraints`
block is placed at the very top of the context. Rationale: a rules preamble at
the head is the conventional place for authoritative instructions; it needs no
marker to locate (fully deterministic); and in most harnesses the head of the
context is the region most likely to be preserved through the *next*
compaction, which is precisely what `pin` is protecting against. Because
`extract` scans for a `constraints` fence anywhere in the text, top placement
does not compromise the round-trip.

*Rejected:* injecting at the end (recency helps attention but the tail is the
region compaction most often rewrites); injecting at an explicit user-supplied
marker (more flexible, but adds a marker convention and a "marker not found"
failure mode for no round-trip benefit).

**2. Merge-vs-replace → replace wholesale.** The pinned block always contains
**exactly** the constraint set passed in — nothing more. If the context already
carries a `constraints` block, `pin` does not union its constraints with the
incoming set; it removes the old block(s) and writes the new set. Rationale: it
keeps `pin` a predictable pure function (`the block == the set you passed`),
it is the only rule under which the round-trip `extract(pin(set, ctx)) === set`
can hold, and it sidesteps the id-conflict resolution that union-by-id would
reintroduce. A caller who *wants* a union composes the small operations
themselves — `pin(dedupe([...extract(ctx), ...newOnes]), ctx)` — which is
exactly the "small composable operations" the roadmap calls for.

*Rejected:* union-by-id (needs a same-id-different-text tie-break rule, breaks
the round-trip, and pushes merge policy into `pin` where it doesn't belong).

## Emitted block format

`pin` writes a single fenced block whose info string is `constraints`, one
constraint per line, in set order, **always using the explicit `[id]` form** of
the `extract` grammar so ids survive verbatim (a bare line would let `extract`
regenerate the id from a slug of the text and break the round-trip):

~~~markdown
```constraints
must [no-pii]: Never include personal data in output.
should [short]: Prefer the shortest correct answer.
```
~~~

An **empty** constraint set emits an empty `constraints` block (open fence +
close fence, no lines); `extract` reads that back as `[]`, so `[]` round-trips
too.

## Desired behavior

- `cg pin <constraints> <context-file>` reads the context file, injects the
  constraint set as a `constraints` block at the top, and prints the **modified
  context to stdout** (it does not edit the file in place — non-destructive and
  composable: `cg pin constraints.json ctx.md > ctx.pinned.md`).
- `<constraints>` is a **JSON file path**, or `-` to read the JSON from
  **stdin**, so it pipes from `extract`:
  `cg extract old.md | cg pin - compacted.md`.
- The constraint set is validated with `validateConstraintSet` (#1) before
  anything is written; an invalid set is a clear non-zero error, not a partial
  write.
- **Round-trip:** `extractConstraints(pinConstraints(set, ctx))` deep-equals
  `set` — same objects, ids, and order — for any set `extract` could have
  produced.
- **Idempotent:** running `pin` twice with the same set is a no-op on the
  second run — `pin(set, pin(set, ctx)) === pin(set, ctx)`. An existing
  `constraints` block is replaced, never appended-beside, so the context never
  accumulates duplicate blocks.
- The library exposes the same logic as a pure function,
  `pinConstraints(constraintSet, context)`, returning the new context string
  (no I/O, deterministic).

## Acceptance criteria

- [ ] `pinConstraints(set, ctx)` (library) returns `ctx` with `set` present as a
      single `constraints` fenced block at the top, one line per constraint in
      order, each in `<severity> [<id>]: <text>` form.
- [ ] **Round-trip:** `extractConstraints(pinConstraints(set, ctx))` deep-equals
      `set` (ids and order included), including when an id is *not* the slug of
      its text and including the empty set `[]`.
- [ ] **Wholesale replace:** if `ctx` already contains a `constraints` block,
      the result contains exactly one `constraints` block holding exactly `set`
      — the previous block's constraints do not survive or merge.
- [ ] **Idempotent:** `pinConstraints(set, pinConstraints(set, ctx))` equals
      `pinConstraints(set, ctx)` byte-for-byte; the context never gains a second
      `constraints` block.
- [ ] The input set is validated with `validateConstraintSet` (#1); an invalid
      set throws (library) / exits non-zero with a clear message (CLI) and
      writes no output.
- [ ] Output is deterministic: same `(set, ctx)` always yields the identical
      string.
- [ ] `cg pin constraints.json ctx.md` prints the modified context to stdout and
      exits `0`; extracting that stdout yields `set`.
- [ ] `cg pin - ctx.md` reads the JSON constraint set from stdin (so
      `cg extract old.md | cg pin - ctx.md` round-trips).
- [ ] A missing/unreadable context file, unreadable/invalid JSON, or a set that
      fails validation each exit non-zero with a clear stderr message; missing
      arguments print usage.
- [ ] Zero runtime dependencies; `pinConstraints` is pure and deterministic.
- [ ] `npm test` covers round-trip, idempotency, wholesale-replace, empty-set,
      explicit-id preservation, validation failure, and the CLI (file + stdin)
      paths.

## Non-goals

- **No union/merge semantics.** `pin` replaces; it does not combine the incoming
  set with constraints already in the context. Composition is left to the caller.
- **No in-place file editing** in v1. `pin` writes to stdout; the caller
  redirects. (A future `--write`/`-w` flag could add in-place editing.)
- **No new injection strategies** (end-of-context, explicit markers) in v1 — top
  only.
- **No schema change** to #1. `pin` consumes and re-emits the existing
  `{ id, text, severity }` shape.
- Not `conformance`/scoring — a separate roadmap item that will *use* pin.

## Open questions (for the reviewer)

1. **Injection point** (the human gate the issue flagged). Spec recommends
   **top of context**. Confirm over end-of-context / explicit-marker before
   implementation.
2. **Merge-vs-replace** (the second flagged gate). Spec recommends **replace
   wholesale**, with union left to caller composition. Confirm over union-by-id.
3. **Non-round-trippable constraints.** A constraint whose `text` contains a
   newline, or whose `id` contains `]` or a newline, cannot be encoded as a
   single `extract`-readable line. Schema #1 permits such values. Recommended:
   `pin` **rejects** these with a clear error rather than emit a block that
   silently fails to round-trip. Confirm reject-vs-sanitize.
