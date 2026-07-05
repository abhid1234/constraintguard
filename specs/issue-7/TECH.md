# TECH — `cg pin`

Issue: [#7](https://github.com/abhid1234/constraintguard/issues/7) · Depends on: #1 (`validateConstraintSet` in `src/schema.js`), #2 (`extractConstraints` in `src/extract.js`)

## Approach

Add a pure function `pinConstraints(constraintSet, context)` in `src/pin.js`
that (1) validates the set with `validateConstraintSet` from #1, (2) encodes it
as a single `constraints` fenced block using the explicit-id form of the #2
`extract` grammar, (3) removes any `constraints` block already present in the
context, and (4) prepends the new block at the top, returning the new context
string. A `pin` case in `bin/cg.js` (sibling to `extract`) reads the constraint
set from a JSON file or stdin (`-`), reads the context file, calls
`pinConstraints`, and writes the result to stdout. Everything is Node standard
library only and free of wall-clock/randomness, so output is deterministic.

The design is anchored on one invariant — **`pin` and `extract` are inverses**:
`extractConstraints(pinConstraints(set, ctx))` deep-equals `set`. Two rules make
that hold: every line is emitted with an explicit `[id]` (so `extract` doesn't
regenerate ids from slugs), and after `pin` there is exactly **one**
`constraints` block containing exactly `set` (so `extract` reads back the set
and nothing else). The same "exactly one block" property gives idempotency for
free.

### Block encoding
- Fence: opening ` ```constraints ` and closing ` ``` ` (triple backtick). One
  line per constraint, in array order:

  ```
  <severity> [<id>]: <text>
  ```

  This matches `extract`'s line regex
  `/^(must|should)\s*(?:\[([^\]]+)\])?\s*:\s*(.+)$/i` with the optional id group
  always present. Severity is written lowercase (`must`/`should`) — the set is
  already validated to those two values.
- **Empty set** → the two fence lines only (open + close, no content). `extract`
  reads an empty block as `[]`, so `[]` round-trips.
- **Encodability guard (open question #3).** Before encoding, reject any
  constraint whose `text` contains `\n`/`\r`, or whose `id` contains `\n`, `\r`,
  or `]` — these cannot be represented as one `extract`-readable line and would
  break the round-trip. Throw a clear error naming the offending id. (If the
  reviewer prefers sanitizing over rejecting, this is the single place to change.)

### Existing-block removal + placement (idempotency)
- Reuse `extract`'s fence-scanning logic to find the line span of every
  `constraints` block (opening fence line through its matching closing fence
  line, inclusive). Do **not** pull in a markdown library; mirror the
  line-by-line scan already in `src/extract.js` (`OPEN_FENCE`, `isClosingFence`).
  Factor the block-span scan into a small shared helper if convenient, but do not
  change `extract`'s public behavior.
- Remove those spans from the context, yielding `rest`.
- Compose the result deterministically so a second `pin` reproduces the first
  byte-for-byte:
  - if `rest.trim() === ''` → `block + '\n'`;
  - else → `block + '\n\n' + rest.replace(/^\s*\n/... leading blank lines .../, '')`
    — i.e. drop leading blank lines left behind by removal before joining, so the
    separator is always exactly one blank line and repeated `pin`s don't grow
    whitespace.
- Idempotency check to satisfy in tests: on the second run the input already
  starts with `block\n\n…`; removing that block and re-prepending must yield the
  identical string. Choose the leading-whitespace normalization above so this
  holds exactly.

> Placement note: because all existing blocks are stripped and the new one is
> prepended, a `constraints` block that was mid-context moves to the top. That is
> intended (see PRODUCT open question #1); it also means an *illustrative*
> `constraints` block in the context (e.g. documentation) is treated as data and
> replaced — consistent with how `extract` already treats any such fence.

### Output contract
- Library: `pinConstraints(set, ctx)` returns the new context `string`. Pure, no
  I/O. Throws on an invalid set (via `validateConstraintSet`) or a
  non-encodable constraint.
- CLI: writes the modified context to **stdout** with a trailing newline; the
  original file is not modified. Exit `0` on success; non-zero with a clear
  stderr message on bad arguments, unreadable/invalid JSON, unreadable context
  file, or a set that fails validation.

## Files / functions to touch

- **`src/pin.js`** (new) — `export function pinConstraints(constraintSet, context)`
  plus internal helpers (`encodeBlock`, `stripConstraintBlocks`,
  `assertEncodable`). Pure; no I/O. Imports `validateConstraintSet` from
  `./schema.js`.
- **`src/index.js`** — add `export { pinConstraints } from './pin.js';` alongside
  the existing `VERSION`, `validateConstraintSet`, and `extractConstraints`
  exports.
- **`bin/cg.js`** — add a `pin` case to `main()`'s switch and a `cmdPin(args)`
  handler beside `cmdExtract`. Update `USAGE` to include
  `cg pin <constraints-json|-> <context-file>`. `cmdPin`:
  - parse args: first non-flag = constraints source (`-` = stdin), second =
    context file; error on missing/extra.
  - read constraints: if `-`, read stdin (`readFileSync(0, 'utf8')`); else
    `readFileSync(path, 'utf8')`. `JSON.parse` it; a parse error → `fail(...)`.
  - read the context file with `readFileSync`; unreadable → `fail(...)`.
  - `const out = pinConstraints(set, ctx)` inside try/catch; validation or
    encodability errors → `fail('pin: ' + err.message)`.
  - `process.stdout.write(out.endsWith('\n') ? out : out + '\n')`.
  - Keep the structure parallel to `cmdExtract` so future subcommands still slot
    in cleanly.
- **`test/pin.test.js`** (new) — library `node --test` coverage (below).
- **`test/cli.test.js`** — add `cg pin` cases (file input, stdin input, error
  paths) using the existing `run`/`fixture` helpers; add a `run(..., { input })`
  usage for stdin.
- **`README.md`** — already documents `cg pin constraints.json ctx.md`; no change
  required (implementer may add the stdin/round-trip note, optional).

## Test plan (`npm test` → `node --test`)

Library (`test/pin.test.js`), importing `pinConstraints`, `extractConstraints`,
`validateConstraintSet` from `../src/index.js`:

1. **Injects a block** — `pin(set, 'prose')` output contains a ` ```constraints `
   fence at the top and the original prose below.
2. **Round-trip** — `extractConstraints(pinConstraints(set, ctx))` deep-equals
   `set`, ids and order included.
3. **Explicit-id preservation** — a set with `id: 'c1'`, `text: 'Never log
   secrets'` (whose slug would be `never-log-secrets`) still round-trips to id
   `c1`, proving the explicit `[id]` form is emitted.
4. **Empty set** — `pin([], ctx)` emits an empty block; `extract` of it is `[]`.
5. **Wholesale replace** — a `ctx` that already has a `constraints` block with
   *different* constraints → after `pin`, exactly one block and
   `extract(result)` deep-equals the new `set` (old constraints gone, not merged).
6. **Idempotent** — `pin(set, pin(set, ctx)) === pin(set, ctx)` byte-for-byte;
   and the result contains exactly one `constraints` fence (count occurrences).
7. **Deterministic** — two `pin(set, ctx)` calls return identical strings.
8. **Invalid set throws** — passing a set that fails `validateConstraintSet`
   (e.g. duplicate id, bad severity) throws.
9. **Non-encodable constraint throws** — `text` with an embedded `\n`, and `id`
   containing `]`, each throw a clear error (open-question #3 behavior).
10. **Empty / no-block context** — `pin(set, '')` yields the block alone;
    `pin(set, 'plain text with no fence')` prepends the block above the text.

CLI (`test/cli.test.js`, extending the existing suite):

11. **`cg pin <json> <ctx>`** — write a constraints JSON fixture and a context
    fixture; `run(['pin', jsonPath, ctxPath])` exits `0`, stdout contains a
    `constraints` block, and `extract` of stdout (or re-running `cg extract` on
    it) yields the set.
12. **stdin (`-`)** — `run(['pin', '-', ctxPath], { input: JSON.stringify(set) })`
    round-trips (mirrors `cg extract old.md | cg pin - ctx.md`).
13. **Invalid JSON** — a constraints file with malformed JSON → status `1`, clear
    stderr.
14. **Set fails validation** — a well-formed-JSON but schema-invalid set → status
    `1`, clear stderr, no stdout block.
15. **Unreadable context file** — `run(['pin', jsonPath, '/no/such.md'])` → status
    `1`, `cannot read`.
16. **Missing args** — `run(['pin'])` / `run(['pin', jsonPath])` → status `1`,
    usage message.

## Risks / edge cases / migrations

- **Round-trip fidelity is the core risk.** Guarded by test 2/3/4 and by always
  emitting explicit ids + collapsing to one block. Any future change to
  `extract`'s grammar must keep `pin`'s encoder in lockstep — the round-trip
  test is the tripwire.
- **Idempotency whitespace.** Naive block removal can leave/accumulate blank
  lines and break byte-for-byte idempotency; the leading-blank-line normalization
  above is the fix, and test 6 enforces it.
- **Non-round-trippable inputs** (newline in text, `]`/newline in id). Schema #1
  allows them; `pin` rejects them (open question #3) rather than emit a silently
  broken block.
- **Illustrative `constraints` blocks** in the context are treated as data and
  replaced — same explicit-fence trade-off `extract` already accepts.
- **CRLF contexts.** Mirror `extract`'s `\r?\n` handling when scanning for
  existing blocks so Windows-authored contexts are matched; the emitted block
  uses `\n`.
- **stdin vs file collision.** Only the *constraints* argument supports `-`; the
  context is always a file (stdin is consumed by the constraints), so there is no
  ambiguity.
- **No migration.** New file `src/pin.js`, one new export in `src/index.js`, new
  CLI subcommand, new tests. No data or format change; `#1`/`#2` untouched.

## Alternatives considered

- **Union-by-id merge** with existing context constraints — needs a
  same-id-different-text tie-break and breaks `extract(pin(set)) === set`.
  Rejected; union is left to caller composition. (PRODUCT open question #2.)
- **Inject at end / at an explicit marker** — end sits in the region compaction
  most rewrites; a marker adds a convention and a not-found failure for no
  round-trip gain. Rejected in favor of top. (PRODUCT open question #1.)
- **Emit bare lines (no `[id]`), relying on slugs** — smaller lines, but
  `extract` would regenerate ids from text and arbitrary ids would not survive.
  Rejected; explicit ids are mandatory for the round-trip.
- **In-place file write** (`pin` edits `ctx.md`) — convenient but destructive and
  less composable; stdout keeps `pin` pure-shell-friendly. Deferred to a possible
  `--write` flag.
