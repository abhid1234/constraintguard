// `cg pin` — re-inject a constraint set into a context so it survives the next
// compaction. `pin` is the inverse of `extract` (#2): it writes a single
// `constraints` fenced block, in the explicit `[id]` form of the extract
// grammar, so that
//
//     extractConstraints(pinConstraints(set, ctx))  deep-equals  set
//
// (same constraints, ids, and order). Two rules make that hold: every line
// carries an explicit `[id]` (so `extract` never regenerates an id from a slug),
// and after `pin` there is exactly ONE `constraints` block containing exactly
// `set` (existing blocks are stripped, not merged). That same "exactly one
// block" property makes `pin` idempotent — `pin(set, pin(set, ctx))` reproduces
// `pin(set, ctx)` byte-for-byte. Pure and deterministic: no I/O, no wall-clock,
// no randomness. Zero dependencies.

import { validateConstraintSet } from './schema.js';

// Opening fence for a `constraints` block (mirrors `src/extract.js`).
const OPEN_FENCE = /^([`~]{3,})[ \t]*constraints[ \t]*$/i;

// Inject `constraintSet` into `context` as a single `constraints` block at the
// top, replacing any `constraints` block(s) already present. Returns the new
// context string. Throws if the set fails `validateConstraintSet` (#1) or if a
// constraint cannot be encoded as one `extract`-readable line.
export function pinConstraints(constraintSet, context) {
  if (typeof context !== 'string') {
    throw new Error(`pin expects a context string, got ${context === null ? 'null' : typeof context}`);
  }
  const set = validateConstraintSet(constraintSet);
  for (const c of set) assertEncodable(c);

  const block = encodeBlock(set);
  const rest = stripConstraintBlocks(context);

  // Drop leading blank lines left behind by removal so the separator between the
  // block and the surviving context is always exactly one blank line — this is
  // what keeps repeated `pin`s from growing whitespace (byte-for-byte idempotent).
  const body = rest.replace(/^(?:[ \t]*\n)+/, '');
  if (body.trim() === '') return block + '\n';
  return block + '\n\n' + body;
}

// Encode a validated constraint set as a `constraints` fenced block (no trailing
// newline). One line per constraint, in array order, always with an explicit id.
// An empty set yields just the open and close fences.
function encodeBlock(set) {
  const lines = ['```constraints'];
  for (const c of set) lines.push(`${c.severity} [${c.id}]: ${c.text}`);
  lines.push('```');
  return lines.join('\n');
}

// Reject constraints that cannot be represented as a single `extract`-readable
// line: a newline in the text, or a newline or `]` in the id, would produce a
// block that silently fails to round-trip (PRODUCT open question #3).
function assertEncodable(c) {
  if (/[\r\n]/.test(c.text)) {
    throw new Error(`constraint "${c.id}" text contains a line break and cannot be pinned as a single line`);
  }
  if (/[\r\n\]]/.test(c.id)) {
    throw new Error(`constraint id "${c.id}" contains a newline or "]" and cannot be pinned`);
  }
}

// Remove every complete `constraints` block (opening fence through its matching
// closing fence, inclusive) from `text`, returning the surviving lines joined by
// `\n`. Mirrors the line-by-line fence scan in `src/extract.js`; an unterminated
// block is treated as content and left in place (same as `extract`).
function stripConstraintBlocks(text) {
  const lines = text.split(/\r?\n/);
  const remove = new Set();
  let fence = null; // opening fence string while inside a block
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (fence == null) {
      const m = raw.match(OPEN_FENCE);
      if (m) {
        fence = m[1];
        start = i;
      }
      continue;
    }
    if (isClosingFence(raw, fence)) {
      for (let j = start; j <= i; j++) remove.add(j);
      fence = null;
      start = -1;
    }
  }

  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (!remove.has(i)) kept.push(lines[i]);
  }
  return kept.join('\n');
}

// True when `raw` closes a fence opened by `openFence` (mirrors `src/extract.js`).
function isClosingFence(raw, openFence) {
  const re = openFence[0] === '`' ? /^(`{3,})[ \t]*$/ : /^(~{3,})[ \t]*$/;
  const m = raw.match(re);
  return m != null && m[1].length >= openFence.length;
}
