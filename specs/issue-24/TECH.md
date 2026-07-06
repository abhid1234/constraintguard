# TECH — Cursor adapter

Issue: [#24](https://github.com/abhid1234/constraintguard/issues/24) · Follows: #13 (`src/harness/` layer + `claude-code.js`), #23 (`codex.js`), #2 (`extractConstraints`), #1 (`validateConstraintSet`)

## Approach

Add a third adapter to the harness layer #13 built, plus a small,
Cursor-specific *discovery* step in the CLI (the only place that does file I/O).
The **library adapter** `cursorToContext(raw, opts) → string` stays a pure
transform like `claude-code`/`codex`: given the text of **one** rule file, it
strips the leading `.mdc` frontmatter (when told the file is `.mdc`) and returns
the body, which flows into the unchanged `extractConstraints`. Because the
```` ```constraints ```` fence (#2) still gates extraction, the adapter does no
constraint detection of its own — it only isolates rule-file text.

Cursor differs from the transcript adapters in one structural way: a project's
rules live across **multiple files**, so a single `(raw: string)` can't
represent a whole project. We keep the purity boundary clean by putting
multi-file **discovery** in `bin/cg.js` (which already owns all `readFileSync`
I/O): when `--harness cursor` receives a **directory**, the CLI enumerates the
rule sources, runs each through the pure `cursorToContext`, and joins them before
one `extractConstraints` call. When it receives a **file**, it adapts that file
alone. The library never touches the filesystem, so it stays deterministic.

## `cursorToContext` — the pure adapter (`src/harness/cursor.js`, new)

```
export function cursorToContext(raw, opts = {})
```

- `raw` — the text of one rule file. If not a string, throw a clear `Error`
  (mirror `claude-code`/`codex`: `cursor adapter expects a string, got …`).
- `opts.mdc` — boolean. When `true`, strip a leading MDC frontmatter block
  before returning; when falsy, return `raw` unchanged (a `.cursorrules` /
  plaintext file has no frontmatter). The CLI sets this from the file extension
  (`.mdc` → `true`), so `.cursorrules` content that merely *starts* with a `---`
  markdown horizontal rule is never mistaken for frontmatter.
- `opts.onWarning` — accepted for signature parity with the other adapters
  (default noop); v1 has no warning path here but keep the shape uniform.

**Frontmatter stripping (only when `opts.mdc`):** an `.mdc` frontmatter block is
the region from a first line that is exactly `---` to the next line that is
exactly `---`. Implementation (zero-dependency, no YAML):

1. Split `raw` on `/\r?\n/`.
2. If line 0 (after an optional UTF-8 BOM) trimmed `=== '---'`, scan forward for
   the next line trimmed `=== '---'`. If found, drop lines `0…closingIndex`
   inclusive and return the remaining lines joined with `\n`. If **no** closing
   `---` exists, treat the file as having *no* frontmatter (return `raw`
   unchanged) — do not swallow the whole body.
3. Otherwise return `raw` unchanged.

The returned body is handed straight to `extractConstraints`; a
```` ```constraints ```` fence that sat *inside* the frontmatter is therefore
gone, and a fence in the body is preserved intact (line structure unchanged, so
#2's line scanner still sees each constraint).

> Note: frontmatter is **stripped, not parsed** — `description`/`globs`/
> `alwaysApply` are never read, so no YAML library and no rule filtering (D2).

## Registry wiring (`src/harness/index.js`)

One-line additions, exactly the extension point #13 documented:

```js
import { cursorToContext } from './cursor.js';

const ADAPTERS = {
  text: (raw) => raw,
  'claude-code': claudeCodeToContext,
  codex: codexToContext,          // (from #23, if landed; otherwise omit)
  cursor: cursorToContext,
};
```

`HARNESSES`, `adaptHarness`, and `extractFromHarness` need no change — they
derive from `ADAPTERS`. `src/index.js` already re-exports all three, so **no
change there** either. (If #23 has not landed when this is implemented, only the
`cursor` line is added; the two are independent.)

## CLI: directory discovery in `cmdExtract` (`bin/cg.js`)

Today `cmdExtract` does one `readFileSync(file)` → `adaptHarness(harness, text)`.
`cursor` needs a directory branch. Keep it contained in a helper so the generic
path is untouched.

1. **Usage string** — add `cursor` to the `--harness` list:
   `usage: cg extract [--strict] [--harness text|claude-code|codex|cursor] <context-file-or-project-dir>`.
2. After resolving `harness` and the single positional `path`, branch:
   - **`harness === 'cursor'`** → call a new local helper
     `readCursorContext(path, onWarning)` that returns the isolated context
     string (details below), instead of the `readFileSync` + `adaptHarness` pair.
   - **otherwise** → unchanged (`readFileSync(path)` then `adaptHarness(...)`).
3. `readCursorContext(path, onWarning)`:
   - `statSync(path)`; on ENOENT/unreadable → `fail('extract: cannot read … ')`
     (same message shape as today).
   - **If a directory:** collect sources in this deterministic order —
     1. `<path>/.cursorrules` if it exists → `cursorToContext(read, { mdc:false })`;
     2. every entry of `<path>/.cursor/rules/` ending in `.mdc`
        (`readdirSync`, filter, **`.sort()`**) → `cursorToContext(read, { mdc:true })`.
     Join the non-empty results with `\n\n`. If **zero** sources were found,
     `onWarning('no Cursor rule sources found under <path> (looked for .cursorrules and .cursor/rules/*.mdc)')`
     and return `''`.
   - **If a file:** `cursorToContext(readFileSync(path), { mdc: path.endsWith('.mdc'), onWarning })`.
   - Return the string; `cmdExtract` then runs the existing
     `extractConstraints(context, { strict, onWarning })` path unchanged.

Everything downstream (JSON print, `[]`+note on empty, `--strict`) is reused
verbatim. `readdirSync`/`statSync` come from `node:fs` (already imported for
`readFileSync`); zero new dependencies.

> Keeping discovery in the CLI (not the library) preserves the pure-adapter
> contract the whole family relies on and matches how `bin/cg.js` already owns
> I/O. The alternative — a directory-aware library function — would put
> filesystem access and non-determinism into `src/`, against the vision.

## Files / functions to touch

- **`src/harness/cursor.js`** (new) — `export function cursorToContext(raw, opts = {})`;
  pure; frontmatter-strip-when-`opts.mdc`; string guard; `opts.onWarning` parity.
- **`src/harness/index.js`** — add the `cursor: cursorToContext` registry line
  (and its import).
- **`bin/cg.js`** — usage string gains `cursor`; `cmdExtract` gains the
  `harness === 'cursor'` branch and the `readCursorContext` helper; import
  `readdirSync`, `statSync` from `node:fs`.
- **`src/index.js`** — no change (re-exports are registry-derived).
- **`test/fixtures/cursor/`** (new) — committed fixtures (below).
- **`test/harness-cursor.test.js`** (new) — library-level tests for
  `cursorToContext` (pure).
- **`test/cli-cursor.test.js`** (new) — CLI tests (file + directory), matching
  the repo's per-command CLI-test split (`cli-harness.test.js`, etc.).

## Fixtures (`test/fixtures/cursor/`, committed)

A small project layout that exercises every branch:

```
test/fixtures/cursor/project/
  .cursorrules                     # plaintext; a ```constraints fence: must [no-secrets]…
  .cursor/rules/
    security.mdc                   # frontmatter (alwaysApply:true) + body fence: must [audit-log]…
    style.mdc                      # frontmatter with globs:"*.ts" (scoped) + body fence: should [tabs]…
    no-fence.mdc                   # frontmatter + prose body, NO fence → contributes nothing
    frontmatter-decoy.mdc          # a ```constraints fence INSIDE the frontmatter → must be excluded
```

> **Gotcha:** the fixtures include dotfiles (`.cursorrules`, `.cursor/`). Ensure
> the repo `.gitignore` / `files` whitelist do **not** exclude them and that
> `git add -f` is used if needed, so the fixtures are actually committed and CI
> can read them. Verify with `git ls-files test/fixtures/cursor`.

Directory-walk test asserts the union of the fixture's real fences
(`no-secrets`, `audit-log`, `tabs`) in sorted-source order, and that the decoy
(frontmatter fence) and the no-fence file contribute nothing.

## Test plan (`npm test` → `node --test`)

Library (`test/harness-cursor.test.js`):
1. **`.cursorrules` pass-through** — `cursorToContext(raw, { mdc:false })` returns
   the text unchanged; `extractFromHarness('cursor', raw)` yields the fenced set.
2. **`.mdc` frontmatter stripped** — with `{ mdc:true }`, a leading `---`…`---`
   block is removed and body fences extract; body line structure is preserved.
3. **Frontmatter-fence excluded** — a ```` ```constraints ```` fence *inside* the
   frontmatter is gone after stripping (nothing extracted from it).
4. **No closing `---`** — a file that opens `---` but never closes it is returned
   unchanged (body not swallowed).
5. **`mdc:false` on `---`-leading text** — a `.cursorrules` starting with a `---`
   horizontal rule is **not** stripped (proves the extension gate).
6. **Determinism** — same input → identical output; result re-validates with
   `validateConstraintSet`.
7. **Type guard** — non-string `raw` throws.
8. **Unknown harness** — `adaptHarness('nope', …)` throws naming the supported
   harnesses (now incl. `cursor`).

CLI (`test/cli-cursor.test.js`, child-process):
9. **File happy path** — `extract --harness cursor <.cursorrules>` → JSON on
   stdout, exit `0`, expected fence extracted, re-validates.
10. **`.mdc` file** — `extract --harness cursor <security.mdc>` extracts the body
    fence; the frontmatter-decoy fixture yields `[]`.
11. **Directory walk** — `extract --harness cursor <project/>` → union of
    `.cursorrules` + `.cursor/rules/*.mdc` fences, deterministic order; decoy and
    no-fence file absent.
12. **Empty directory** — a temp dir with no rule sources → `[]`, exit `0`, stderr
    note "no Cursor rule sources found".
13. **No-fence project** — a rule file with no fence → `[]`, exit `0`, "no
    constraints found" note.
14. **Unknown harness** — `extract --harness borg …` exits non-zero listing
    supported harnesses including `cursor`.
15. **No-regression** — `--harness text` (and omitting `--harness`) is
    byte-for-byte identical to today for a plain markdown file.

## Risks / edge cases / migrations

- **Product risk — empty results on real projects (D1).** Existing Cursor rule
  files have no ```` ```constraints ```` fence, so extraction returns `[]` until
  an operator adds one. This is the intended opt-in behavior, but it is the
  feature's main perception risk; called out as Open Question 1 for the reviewer.
- **Dotfile fixtures not committed.** `.cursorrules` and `.cursor/` are hidden;
  if `.gitignore` or the `package.json` `files` whitelist drops them, CI reads an
  empty project and tests silently pass/fail wrong. Mitigation: the fixture
  gotcha above + a `git ls-files` check.
- **Frontmatter horizontal-rule collision.** A `.cursorrules` or body starting
  with `---` could look like frontmatter; mitigated by gating stripping on the
  `.mdc` extension (`opts.mdc`), so only real `.mdc` files are stripped (test 5).
- **`.mdc` with no closing `---`.** Handled by "no closing → treat as no
  frontmatter" so a malformed file never loses its body (test 4).
- **Directory read failures.** A `.cursor/rules/` that exists but isn't readable,
  or a `.cursorrules` that's a directory, etc. — wrap `statSync`/`readdirSync` in
  the same `fail(...)`/skip handling as `readFileSync` today; a *missing*
  `.cursorrules`/`rules/` dir is normal (not an error), a *present-but-unreadable*
  one fails clearly.
- **Ordering / id collisions across files.** Sources are read in a fixed sorted
  order and joined with `\n\n`; duplicate ids across files are de-conflicted by
  `extractConstraints` (#2), so the output always validates (#1). No new logic.
- **Large `.cursor/rules/` trees.** `readdirSync` (non-recursive, single dir) is
  O(files) and fine for a CLI; recursion/monorepo discovery is a documented
  non-goal.
- **No migration.** Additive: one new library file, one registry line, one CLI
  branch + helper, new fixtures/tests. No schema, data, or existing-harness
  change; `--harness text`/`claude-code` are untouched.

## Alternatives considered

- **Prose → constraint inference** (ingest rule text without a fence) — needs a
  new severity/boundary detector #2 deliberately avoids; reintroduces false
  positives and diverges the adapter family. Rejected; it's a separate importer
  feature (D1 / Open Question 1).
- **File-only input (no directory walk)** — byte-for-byte symmetric with #13/#23
  (no `bin/cg.js` logic change), but forces one invocation per `.mdc`, which
  fits Cursor's multi-file model poorly. Rejected as default; offered as Open
  Question 2.
- **Directory-walking *library* function** — would let the library ingest a
  whole project, but injects filesystem I/O and non-determinism into `src/`,
  against the pure-adapter contract and the vision. Rejected; discovery lives in
  the CLI.
- **Parse `.mdc` frontmatter and filter on `alwaysApply`/`globs`** — pulls in
  frontmatter *semantics* (and near-YAML parsing) for a filtering behavior the
  fence-opt-in already covers. Rejected as default (Open Question 3); we only
  *strip* frontmatter.
- **Depend on a YAML / frontmatter package** — violates zero-dependency; a
  4-line `---`…`---` strip is all we need. Rejected.
- **A separate `cg adapt cursor` / `cg cursor` subcommand** — already settled for
  the family in #13 (Q2): `--harness` folds the step in with the least surface.
  Rejected.
