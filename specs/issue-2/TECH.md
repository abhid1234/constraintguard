# TECH — `cg extract`

Issue: [#2](https://github.com/abhid1234/constraintguard/issues/2) · Depends on: #1 (`validateConstraintSet` in `src/schema.js`)

## Approach

Add a pure function `extractConstraints(text, opts)` in `src/extract.js` that
scans a context string, pulls every fenced block whose info string is
`constraints`, parses each content line with a single regex into
`{ id, text, severity }`, generates ids where absent, de-duplicates, and returns
the constraint set array. A thin CLI in `bin/cg.js` (created here — it is
declared in `package.json`'s `bin` but does not exist yet) dispatches the
`extract` subcommand: read the file, call `extractConstraints`, pretty-print the
JSON to stdout, and route warnings to stderr. Everything is Node standard
library only; no parse step depends on wall-clock or randomness, so output is
fully deterministic. The result is validated with `validateConstraintSet` from
#1 before printing, so a bad emit fails loudly rather than producing a set the
rest of the toolchain would reject.

### Block detection
- Recognize fenced blocks opened by ` ``` ` or `~~~` with the info string
  `constraints` (case-insensitive, surrounding whitespace ignored), closed by a
  matching fence. Scan line-by-line; do not use a markdown library.
- Collect the content lines of every matching block, preserving document order.

### Line grammar
Trim each content line; ignore blanks and lines starting with `#`. Match:

```
/^(must|should)\s*(?:\[([^\]]+)\])?\s*:\s*(.+)$/i
```

- group 1 → `severity` (lowercased to `must`/`should`).
- group 2 → explicit `id` (verbatim, trimmed) if present.
- group 3 → `text` (trimmed); if empty after trim, the line is malformed.
- No match → malformed line: record `{ line, raw }`, skip (default) or throw
  (`--strict`).

### Id generation & dedup
- Explicit `[id]` is used verbatim.
- Otherwise `id = slug(text)`: lowercase, replace each run of non-alphanumeric
  characters with `-`, strip leading/trailing `-`, truncate to 40 chars.
- Uniqueness pass in output order: if a generated id collides, append `-2`,
  `-3`, …. If an *explicit* id collides with a different `(text, severity)`,
  it's a conflict — keep the first, warn (or throw under `--strict`).
- De-dup: drop any line whose full `(id, text, severity)` already appeared.

### Output contract
- Library: returns `Array<{ id, text, severity }>` (may be empty).
- CLI: `JSON.stringify(set, null, 2)` to stdout + trailing newline; warnings and
  the "no constraints found" note to stderr; exit `0` on success (including
  empty), non-zero on unreadable file or (under `--strict`) malformed input.

## Files / functions to touch

- **`src/extract.js`** (new) — `export function extractConstraints(text, opts = {})`
  plus small internal helpers (`findConstraintBlocks`, `parseLine`, `slug`,
  `ensureUniqueIds`). Pure; no I/O.
- **`src/index.js`** — re-export `extractConstraints` alongside `VERSION` (and
  `validateConstraintSet` once #1 lands).
- **`bin/cg.js`** (new) — minimal argv dispatcher with an `extract <file>`
  subcommand (and `--strict` flag); reads the file with
  `node:fs`'s `readFileSync`, calls `extractConstraints`, validates with
  `validateConstraintSet`, prints JSON. Structured so future subcommands
  (`validate`, `pin`, `conformance`) slot in as sibling cases. Executable, with
  a `#!/usr/bin/env node` shebang.
- **`test/extract.test.js`** (new) — `node --test` coverage (below).

> If #1 has not merged when this is implemented, either land #1 first or have
> the CLI import `validateConstraintSet` behind a guard; do not duplicate the
> validator here.

## Test plan (`npm test` → `node --test`)

1. **Happy path** — a markdown string with one `constraints` block, mixed
   `must`/`should`, some explicit ids — asserts exact `{ id, text, severity }`
   objects and that `validateConstraintSet` accepts the result.
2. **Case-insensitive severity** — `MUST`/`Should` parse to `must`/`should`.
3. **Generated ids** — lines without `[id]` get deterministic slugs; a second
   run on the same input yields identical ids.
4. **Id collision** — two slug-equal texts produce `id` and `id-2`.
5. **Multiple blocks** — two `constraints` blocks extract in document order.
6. **No block** — text with no `constraints` fence returns `[]`.
7. **Malformed line (lenient)** — a bad line is skipped, surrounding valid lines
   still extracted; malformed lines are reported (returned in opts/collector or
   via a warning hook the CLI prints).
8. **Strict mode** — `{ strict: true }` throws on the first malformed line / id
   conflict.
9. **Dedup** — an identical line appearing twice yields one constraint.
10. **CLI smoke** — invoke `bin/cg.js extract <fixture>` via a child process (or
    call the dispatcher directly); assert JSON on stdout, exit `0`, and that
    stdout parses and re-validates.

## Risks / edge cases / migrations

- **Coupling to #1** — extract must emit exactly the #1 schema. If the schema
  shape changes, extract's mapping changes with it. Mitigated by validating
  output against `validateConstraintSet` in tests and the CLI.
- **False positives** — a `constraints` fenced block used illustratively in docs
  would be extracted. Accepted: the fence is an explicit opt-in; the alternative
  (heuristic detection) is worse.
- **Nested/unterminated fences** — an opened `constraints` fence with no close
  runs to EOF; treat trailing lines as content and note it on stderr rather than
  crashing.
- **CRLF / trailing whitespace** — normalize line endings and trim before
  matching so Windows-authored contexts parse.
- **Empty file / non-UTF8 / missing file** — CLI exits non-zero with a clear
  message; the library treats empty text as `[]`.
- **No migration** — new files only; `src/index.js` gains an export. No data or
  format change.

## Alternatives considered

- **Heading convention** (`## Constraints` + list items) — natural to author but
  high false-positive rate and fragile to markdown formatting; the heading text
  carries no severity, forcing a second convention. Rejected.
- **Inline markers** (`@constraint must: …` anywhere in prose) — flexible but
  noisy to parse, easy to trip on by accident, and leaks a ConstraintGuard-ism
  into arbitrary text. Rejected; could return later behind a flag.
- **LLM/NLP inference from prose** — best ergonomics, but non-deterministic, not
  reproducible, and violates the zero-dependency line. Rejected.
- **Sequential ids (`c1..cN`)** — simpler than slugs but unstable when lines are
  inserted, weakening cross-references for `pin`/`conformance`. Rejected in
  favor of slugs (flagged as an open question).
