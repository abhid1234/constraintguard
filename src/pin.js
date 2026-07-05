// `cg pin` — re-inject a constraint set into a context so the rules survive the
// next compaction. This is the counterpart to `extract` (#2): whatever `pin`
// writes, `extract` must read back exactly, so the two round-trip.
//
// Emitted format — a single `constraints` fenced block, one line per
// constraint, with the id always written explicitly so `extract` reads it back
// verbatim instead of re-deriving it from the text:
//
//     ```constraints
//     must [id]: text
//     should [id]: text
//     ```
//
// Design decisions (the two questions the issue flagged as open):
//   1. Injection point — the block is placed at the TOP of the context. It is
//      the first thing an agent (or a compactor) sees, and a fixed position
//      makes the output deterministic and idempotent.
//   2. Merge-vs-replace — replace WHOLESALE. Any pre-existing `constraints`
//      block(s) are removed and the supplied set becomes the single source of
//      truth. This keeps `pin` idempotent (running it twice cannot duplicate a
//      block) and makes `extract(pin(set, ctx))` return exactly `set`.
//
// Pure and deterministic: no I/O, no wall-clock, no randomness. Zero
// dependencies.

import { validateConstraintSet } from './schema.js';

// The fence used for the emitted block. Must match `extract`'s OPEN_FENCE.
const FENCE = '```';
// Opening fence of a `constraints` block (mirrors extract.js).
const OPEN_FENCE = /^([`~]{3,})[ \t]*constraints[ \t]*$/i;

// Pin a constraint set into a context string.
//   constraintSet — Array<{ id, text, severity }>, validated against #1.
//   context       — the context text to inject the block into.
// Returns the context with a single `constraints` block at the top, replacing
// any block(s) already present. Round-trips with `extractConstraints`.
export function pinConstraints(constraintSet, context) {
  const set = validateConstraintSet(constraintSet);
  if (typeof context !== 'string') {
    throw new Error(`pin expects a string context, got ${context === null ? 'null' : typeof context}`);
  }

  for (const c of set) assertEncodable(c);

  const block = renderBlock(set);
  // Drop any existing constraints block(s), then trim the blank lines they
  // leave behind so the output is stable under repeated pinning.
  const body = stripConstraintBlocks(context).replace(/^\n+/, '');

  return body === '' ? block : `${block}\n\n${body}`;
}

// A constraint is schema-valid but not necessarily *encodable*: the emitted
// format is one line per constraint (`severity [id]: text`), and `extract` reads
// it back by trimming each field and requiring non-empty text. So a text with an
// embedded newline splits into a non-constraint physical line; an empty or
// whitespace-only text is dropped entirely by extract's non-empty-text rule; and
// leading/trailing whitespace on text or id is silently stripped on read-back.
// An id containing a newline or a `]` breaks the `[id]:` delimiter. Every one of
// these corrupts the round-trip silently — the exact failure `pin` exists to
// prevent. Reject rather than emit a quietly-broken block, naming the offending
// constraint.
function assertEncodable(c) {
  if (/[\r\n]/.test(c.text)) {
    throw new Error(`constraint "${c.id}" has non-encodable text: text must not contain a newline`);
  }
  if (c.text.trim() === '') {
    throw new Error(`constraint "${c.id}" has non-encodable text: text must not be empty or whitespace-only`);
  }
  if (c.text.trim() !== c.text) {
    throw new Error(`constraint "${c.id}" has non-encodable text: text must not have leading or trailing whitespace`);
  }
  if (/[\r\n\]]/.test(c.id)) {
    throw new Error(`constraint "${c.id}" has non-encodable id: id must not contain a newline or "]"`);
  }
  if (c.id.trim() !== c.id) {
    throw new Error(`constraint "${c.id}" has non-encodable id: id must not have leading or trailing whitespace`);
  }
}

// Render a constraint set as a `constraints` fenced block (no trailing newline).
function renderBlock(set) {
  const lines = set.map((c) => `${c.severity} [${c.id}]: ${c.text}`);
  return [`${FENCE}constraints`, ...lines, FENCE].join('\n');
}

// Remove every `constraints` fenced block (fence lines and their content) from
// the text, preserving all other lines. Fence matching mirrors extract.js so
// the two agree on what a block is.
function stripConstraintBlocks(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let fence = null; // the opening fence string while inside a block

  for (const raw of lines) {
    if (fence == null) {
      const m = raw.match(OPEN_FENCE);
      if (m) {
        fence = m[1];
        continue; // drop the opening fence line
      }
      kept.push(raw);
      continue;
    }
    // Inside a constraints block: drop content and the closing fence.
    if (isClosingFence(raw, fence)) fence = null;
  }

  return kept.join('\n');
}

// True when `raw` closes a fence opened by `openFence` (same fence char, length
// at least the opening fence, nothing but the fence char and trailing space).
function isClosingFence(raw, openFence) {
  const re = openFence[0] === '`' ? /^(`{3,})[ \t]*$/ : /^(~{3,})[ \t]*$/;
  const m = raw.match(re);
  return m != null && m[1].length >= openFence.length;
}
