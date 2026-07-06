// Cursor harness adapter (#24).
//
// Isolates the constraint-bearing text of a *single* Cursor rule file so it can
// flow into the unchanged `extractConstraints` (#2). Cursor declares its rules
// in dedicated files: the legacy plaintext `.cursorrules` at the repo root, and
// the newer `.cursor/rules/*.mdc` files (Markdown-with-frontmatter). This
// adapter only narrows *where* to read; the ```constraints``` fence (#2) remains
// the sole marker of a declared constraint — the adapter does no inference of
// its own.
//
// Like `claude-code`, it is a pure `(raw, opts) → string` transform: no I/O, no
// clock, no randomness, zero dependencies. Multi-file project *discovery* lives
// in the CLI (`bin/cg.js`), which owns all filesystem access; the library only
// ever sees one rule file's text at a time.

// Turn one raw rule-file's text into the isolated constraint-bearing context.
//   opts.mdc       — when true, strip a leading `.mdc` frontmatter block before
//                    returning; when falsy, return `raw` unchanged (a plaintext
//                    `.cursorrules` has no frontmatter). The CLI sets this from
//                    the file extension, so a `.cursorrules` that merely *starts*
//                    with a `---` markdown horizontal rule is never mistaken for
//                    frontmatter.
//   opts.onWarning — accepted for signature parity with the other adapters
//                    (default noop); v1 has no warning path here.
// Returns a string ready to hand straight to `extractConstraints`.
export function cursorToContext(raw, opts = {}) {
  if (typeof raw !== 'string') {
    throw new Error(`cursor adapter expects a string, got ${raw === null ? 'null' : typeof raw}`);
  }
  // onWarning accepted for parity with the other adapters; unused in v1.
  if (!opts.mdc) return raw;
  return stripFrontmatter(raw);
}

// Strip a leading MDC frontmatter block: the region from a first line that is
// exactly `---` to the next line that is exactly `---`. Zero-dependency, no YAML
// parse — frontmatter (`description`/`globs`/`alwaysApply`) is dropped, never
// interpreted. If there is no leading `---`, or it never closes, `raw` is
// returned unchanged so a body is never accidentally swallowed.
function stripFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  // Tolerate a leading UTF-8 BOM on the first line.
  const first = lines.length > 0 ? lines[0].replace(/^﻿/, '').trim() : '';
  if (first !== '---') return raw;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      // Drop lines 0…i inclusive; return the remaining body.
      return lines.slice(i + 1).join('\n');
    }
  }
  // No closing `---`: treat the file as having no frontmatter.
  return raw;
}
