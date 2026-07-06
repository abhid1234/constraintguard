# PRODUCT — Cursor adapter: extract constraints from Cursor rules

Issue: [#24](https://github.com/abhid1234/constraintguard/issues/24) · Follows: #13 (Claude Code adapter, shipped), #23 (Codex adapter, in review) · Depends on: #2 (`cg extract`, shipped)

## Problem / motivation

The harness layer #13 built lets `cg extract --harness <name>` point
ConstraintGuard at a *live* agent's context, and the roadmap calls for the same
across harnesses. **Cursor** is the next one. Unlike a Claude Code transcript or
a Codex rollout — one append-only `.jsonl` artifact where the operator's
constraints are buried in a conversation — a Cursor project declares its rules in
**dedicated rule files**: the legacy `.cursorrules` plaintext file at the repo
root, and the newer `.cursor/rules/*.mdc` files (Markdown-with-frontmatter). We
add a `cursor` adapter that reads those rule sources, isolates their
constraint-bearing text, and feeds it into the existing `extract` logic — a
one-line entry in the adapter registry #13 already exposes.

## Recommended direction

The issue flags one decision — *which Cursor rule sources count as declared
constraints* — and its triage comment breaks that into three sub-decisions
(source scope, `.mdc` frontmatter parsing, input shape). All are resolved here;
the two that carry real product weight are also surfaced as open questions for
the reviewer, because they materially shape how the feature behaves on a
real-world Cursor project.

### D1 — The `constraints` fence still gates extraction (the adapter *isolates*, it does not *infer*)

**Recommendation: the `cursor` adapter isolates the text of rule files and hands
it to the unchanged `extractConstraints`; the ```` ```constraints ```` fence (#2)
remains the only marker of a declared constraint.** The adapter narrows *where*
to read (rule files, not arbitrary project files); it does **not** add a new way
to detect constraints from prose.

This is the crux of the issue, and it is a genuine fork:

- **Recommended — fence-required isolation.** An operator who wants
  ConstraintGuard to track a Cursor rule adds a ```` ```constraints ```` fence to
  `.cursorrules` or a `.mdc` rule body, exactly as they would in any other
  context. Consistent with #13/#23 (the adapter isolates source text; the fence
  is the opt-in), consistent with the vision ("the explicit fence remains the
  only marker"), zero-dependency, near-zero false positives.
- **Rejected — treat rule prose as constraints.** Cursor rule files *are*
  declared rules by nature ("Always use TypeScript. Never commit secrets."), so
  it is tempting to ingest their prose directly. But that requires a **new
  inference engine**: guessing `must`/`should` severity from prose and guessing
  where one rule ends and the next begins. #2 explicitly refuses prose inference
  ("Nothing outside a `constraints` fence is ever treated as a rule"), and the
  vision says a change that "reaches beyond constraints" is probably out of
  scope. It would also diverge this adapter from the #13/#23 family and
  reintroduce false positives. A prose→constraints *importer* is a separate,
  larger piece of work; it should not ride inside this adapter.

> **Honest limitation (flagged for the reviewer as Open Question 1):** because
> real-world `.cursorrules` / `.mdc` files rarely contain a ```` ```constraints ````
> fence today, pointing `cg extract --harness cursor` at an existing Cursor
> project will usually return `[]` until the operator adds a fence. That is the
> correct, on-vision behavior (opt-in, no false positives), but the reviewer
> should confirm it is the intended product feel before implementation.

### D2 — Source scope: **both `.cursorrules` and `.cursor/rules/*.mdc`, no frontmatter filtering**

The adapter reads:

- **`.cursorrules`** — the legacy single plaintext file at the project root.
- **`.cursor/rules/*.mdc`** — every `.mdc` rule file in the project-root
  `.cursor/rules/` directory.

For a `.mdc` file, the leading YAML-style **frontmatter** (delimited by `---` …
`---`, carrying `description`, `globs`, `alwaysApply`) is **stripped** and only
the rule **body** is scanned. We do *not* filter rules on their frontmatter:
a ```` ```constraints ```` fence in a glob-scoped rule (`globs: "*.py"`) or an
`alwaysApply: false` rule is still extracted. Rationale: the fence is already the
explicit opt-in — the operator marked that block as a constraint on purpose;
`globs`/`alwaysApply` govern *when Cursor shows the rule to the model*, not
*whether the operator declared a constraint*. (Whether to exclude glob-scoped
rules is Open Question 3.)

Crucially, **frontmatter is only stripped, never parsed** — we need no YAML
library, so the zero-dependency line holds. See TECH for how the CLI tells the
adapter a file is `.mdc`.

### D3 — Input shape: **a path that is either a single rule file or a project root**

`cg extract --harness cursor <path>`:

- If `<path>` is a **file** (`.cursorrules`, a `.mdc`, or any rule file), it is
  read and adapted directly — the simple, CI-friendly, #13-symmetric case.
- If `<path>` is a **directory** (a project root), the CLI discovers the rule
  sources under it — `<dir>/.cursorrules` and `<dir>/.cursor/rules/*.mdc`, in a
  deterministic sorted order — adapts each, and joins them into one context
  before extracting.

A real Cursor project spreads rules across many `.mdc` files, so directory
support is what makes the adapter actually useful; file support keeps the
minimal, transcript-adapter-symmetric path available. Directory *discovery*
(the only new I/O) lives in `bin/cg.js`, which already owns all file reading —
the library adapter stays a pure `(raw, opts) → string` transform like #13/#23.
(File-only, à la #13, is the rejected simpler alternative — Open Question 2.)

## Desired behavior

- `cg extract --harness cursor <file>` reads one rule file, isolates its
  constraint-bearing text (stripping `.mdc` frontmatter when the file is `.mdc`),
  runs the existing extractor, and prints the constraint set as pretty JSON to
  **stdout** — identical output contract to plain `cg extract`.
- `cg extract --harness cursor <dir>` reads `<dir>/.cursorrules` and every
  `<dir>/.cursor/rules/*.mdc`, in sorted order, adapts and joins them, and prints
  the combined constraint set. Missing sources are simply absent (no error).
- The emitted set always passes `validateConstraintSet` (#1): unique ids, valid
  severities, non-empty text. Ids that collide across rule files are
  de-conflicted by the existing `extractConstraints` id logic (#2).
- **No constraints found** is a normal result, not an error: print `[]`, exit
  `0`, with the existing one-line stderr note. If a directory contains **no**
  recognizable rule sources at all, an extra stderr note says so.
- `--strict` keeps its #2 meaning: the first malformed *constraint line* or id
  conflict is a non-zero exit. Nothing about reading rule files is a
  strict-fatal condition.
- An **unknown harness name** exits non-zero listing the supported harnesses.
- A **missing/unreadable path** exits non-zero with a clear message (as today).
- The library exposes the adapter as a pure function so programmatic callers can
  go rule-file-string → constraint set without the CLI.

## Acceptance criteria

- [ ] `cg extract --harness cursor <file.cursorrules>` extracts every constraint
      declared in a ```` ```constraints ```` fence in the file, and prints the
      pretty-printed JSON set to stdout, exit `0`.
- [ ] `cg extract --harness cursor <file.mdc>` strips the leading `---`…`---`
      frontmatter and extracts constraints from the rule **body**; a
      ```` ```constraints ```` fence that appears *inside the frontmatter* is
      **not** extracted.
- [ ] `cg extract --harness cursor <dir>` reads `<dir>/.cursorrules` **and**
      `<dir>/.cursor/rules/*.mdc`, in deterministic sorted order, and extracts
      the union of their constraints; the run is deterministic across invocations.
- [ ] A glob-scoped / `alwaysApply: false` `.mdc` rule that contains a
      ```` ```constraints ```` fence **is** extracted (no frontmatter filtering).
- [ ] Output always validates against `validateConstraintSet` (#1); id collisions
      across files are de-conflicted, not dropped silently as errors.
- [ ] A rule file (or project) with **no** ```` ```constraints ```` fence →
      `[]`, exit `0`, stderr note.
- [ ] A directory with no `.cursorrules` and no `.cursor/rules/*.mdc` → `[]`,
      exit `0`, with a stderr note that no Cursor rule sources were found.
- [ ] Omitting `--harness` (or `--harness text`) is byte-for-byte today's
      `cg extract` behavior — #2 has no regression; existing harnesses
      (`claude-code`) are unaffected.
- [ ] An unknown `--harness <name>` exits non-zero listing supported harnesses
      (now including `cursor`).
- [ ] Committed fixtures — a `.cursorrules`, at least one `.mdc` with
      frontmatter, and a small project-root layout — drive the tests.
- [ ] Zero runtime dependencies; the library adapter is pure and deterministic
      (no I/O, clock, or randomness); no YAML/frontmatter parsing library.
- [ ] `npm test` covers: `.cursorrules` file, `.mdc` frontmatter stripping,
      frontmatter-fence exclusion, directory walk (both sources, sorted),
      no-fence → `[]`, empty-directory note, unknown-harness, and the
      `--harness text` no-regression case.

## Non-goals

- **No prose → constraint inference.** The ```` ```constraints ```` fence remains
  the only marker. The adapter isolates rule-file text; it does not invent
  severity or boundaries from free prose (see D1).
- **No frontmatter *parsing* / semantics.** `description`, `globs`, and
  `alwaysApply` are stripped, not interpreted; no rule filtering, precedence, or
  glob evaluation. (Zero-dependency; no YAML library.)
- **No new harnesses in this issue.** Only `cursor` ships; the registry keeps
  additions one-line.
- **No nested / monorepo `.cursor/rules/` discovery.** Only the project-root
  `.cursorrules` and `<root>/.cursor/rules/*.mdc` are read; nested per-package
  `.cursor/rules/` directories, `**` recursion, and symlink following are out of
  scope for v1 (note in TECH).
- **No changes to the constraint schema (#1) or to `extractConstraints`'s
  grammar (#2).** The adapter only produces text `extract` already understands.
- **No live-project auto-discovery beyond the passed path.** The user names the
  file or root explicitly; no walking up from cwd to find a project root.

## Open questions (for the reviewer)

1. **Fence-required, or ingest rule prose?** (The headline decision.) Default —
   **fence-required**: the adapter isolates rule text, the ```` ```constraints ````
   fence stays the opt-in, so pointing at an existing Cursor project with no
   fences returns `[]`. This is consistent with #2/#13/#23 and the vision, and
   has near-zero false positives, but it does **not** magically ingest the
   free-prose rules a team already wrote. The alternative (prose → constraints)
   needs a new inference grammar that #2 deliberately avoids and is really a
   separate "cursor-rules importer" feature. Confirm the opt-in feel is intended
   before implementation.
2. **Input shape — file-and-directory, or file-only?** Default —
   **file-and-directory** (a project root walks `.cursorrules` +
   `.cursor/rules/*.mdc`), because that is how Cursor projects are actually
   organized. File-only would keep the CLI byte-for-byte symmetric with #13/#23
   (no `bin/cg.js` logic change) but forces one invocation per rule file. Pick
   file-only if you want the minimal v1 and defer the walk.
3. **Glob-scoped rules — include or exclude?** Default — **include all rule
   files** (the fence is the opt-in; `globs`/`alwaysApply` govern Cursor's
   display, not whether a constraint was declared). If you'd rather only
   `alwaysApply: true` / unscoped rules count as "always-on" constraints, we add
   a frontmatter check — but that pulls minimal frontmatter *parsing* back in.
