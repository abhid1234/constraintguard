// Google Antigravity harness adapter.
//
// Isolates the constraint-bearing text of an Antigravity agent-rules file so it
// can flow into the unchanged `extractConstraints` (#2). Antigravity declares
// its agent guidelines as Markdown — an `AGENTS.md` at the repo root and
// `.antigravity/rules/*.md` rule files — which may carry a leading YAML
// frontmatter block. This adapter only narrows *where* to read; the
// ```constraints``` fence (#2) remains the sole marker of a declared
// constraint — the adapter does no inference of its own.
//
// Like `cursor`, it is a pure `(raw, opts) → string` transform: no I/O, no
// clock, no randomness, zero dependencies. Multi-file project *discovery* lives
// in the CLI (`bin/cg.js`), which owns all filesystem access; the library only
// ever sees one rule file's text at a time.

// Turn one raw rule-file's text into the isolated constraint-bearing context.
//   opts.frontmatter — when true, strip a leading YAML frontmatter block before
//                      returning; when falsy (default), return `raw` unchanged.
//                      The CLI sets this from the file shape, so a plain
//                      `AGENTS.md` that merely *starts* with a `---` markdown
//                      horizontal rule is never mistaken for frontmatter.
//   opts.onWarning   — accepted for signature parity with the other adapters
//                      (default noop); v1 has no warning path here.
// Returns a string ready to hand straight to `extractConstraints`.
export function antigravityToContext(raw, opts = {}) {
  if (typeof raw !== 'string') {
    throw new Error(`antigravity adapter expects a string, got ${raw === null ? 'null' : typeof raw}`);
  }
  // onWarning accepted for parity with the other adapters; unused in v1.
  if (!opts.frontmatter) return raw;
  return stripFrontmatter(raw);
}

// Strip a leading YAML frontmatter block: the region from a first line that is
// exactly `---` to the next line that is exactly `---`. Zero-dependency, no YAML
// parse — the frontmatter is dropped, never interpreted. If there is no leading
// `---`, or it never closes, `raw` is returned unchanged so a body is never
// accidentally swallowed.
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
