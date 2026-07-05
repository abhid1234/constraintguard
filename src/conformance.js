// `cg conformance` — score how well constraints survive context compaction.
//
// Given an *original* context and a *compacted* context, extract the constraints
// declared in each (via `extractConstraints`, #2) and report how many of the
// original constraints are still declared in the compacted context. The result
// is a retention score plus the exact list of constraints that were dropped.
//
// Survival rule (opts.match):
//   - 'exact' (default): an original constraint survives iff the compacted set
//     contains a constraint with the same `id`, `text`, AND `severity`. A
//     reworded text or a `must`→`should` downgrade counts as dropped.
//   - 'id': an original constraint survives iff its `id` is present in the
//     compacted set (text and severity may differ) — for explicit-id workflows.
//
// Pure and deterministic: no I/O, no wall-clock, no randomness. Zero
// dependencies beyond `extractConstraints`.

import { extractConstraints } from './extract.js';

// Score conformance of `compacted` against `original`.
//   opts.match     — 'exact' (default) or 'id'.
//   opts.strict    — passed through to extraction of both contexts.
//   opts.onWarning — called `(message, source)` for each extraction warning,
//                    where `source` is 'original' or 'compacted' so the caller
//                    can tell the two contexts apart.
// Returns { score, total, survived, dropped }:
//   total    — number of constraints extracted from the original context.
//   survived — count of original constraints found intact in the compacted set.
//   dropped  — full original constraint objects not matched, in document order.
//   score    — survived / total, in [0, 1]; 1 when total === 0.
export function scoreConformance(original, compacted, opts = {}) {
  const match = opts.match ?? 'exact';
  if (match !== 'exact' && match !== 'id') {
    throw new Error(`conformance: unknown match mode ${JSON.stringify(match)}`);
  }
  const strict = opts.strict === true;
  const warn = typeof opts.onWarning === 'function' ? opts.onWarning : null;
  const extractFor = (source) => ({
    strict,
    onWarning: warn ? (msg) => warn(msg, source) : undefined,
  });

  const originalSet = extractConstraints(original, extractFor('original'));
  const compactedSet = extractConstraints(compacted, extractFor('compacted'));

  if (originalSet.length === 0) {
    return { score: 1, total: 0, survived: 0, dropped: [] };
  }

  // extract guarantees unique ids within a set, so index the compacted set by id.
  const compIndex = new Map();
  for (const c of compactedSet) compIndex.set(c.id, c);

  const dropped = [];
  let survived = 0;
  for (const c of originalSet) {
    if (matches(c, compIndex, match)) survived++;
    else dropped.push(c);
  }

  const total = originalSet.length;
  return { score: survived / total, total, survived, dropped };
}

// True when constraint `c` survives in the compacted set (indexed by id).
function matches(c, compIndex, mode) {
  const comp = compIndex.get(c.id);
  if (comp === undefined) return false;
  if (mode === 'id') return true;
  return comp.text === c.text && comp.severity === c.severity;
}
