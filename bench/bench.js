// ConstraintRot reproduction benchmark.
//
// ConstraintGuard cites the ConstraintRot study (arXiv 2606.22528): declared
// constraint-violation rates jump from 0% to as high as 59% after a context is
// compacted. This benchmark reproduces that drop with our own tooling. It scans
// committed sample *sessions* — each a directory holding an `original.md`
// (context + declared constraints) and a `compacted.md` (the summarized
// version) — scores every pair with `scoreConformance` (#8), and prints a
// retention table plus an aggregate ConstraintRot rate.
//
// Fixtures are synthetic on purpose: deterministic, dependency-free, and
// reproducible in CI, so `npm run bench` always shows the same measurable drop.
// Real captured traces can be dropped into `fixtures/` later using the same
// two-file shape. Zero runtime dependencies: Node standard library only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scoreConformance } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, 'fixtures');

// Run the benchmark over every session fixture in `dir`. A session is any
// subdirectory containing both `original.md` and `compacted.md`. Sessions are
// processed in sorted-name order so the report is stable.
//   opts.match — 'exact' (default) or 'id', passed through to scoreConformance.
// Returns { match, sessions, totals } where each session is
// { name, score, total, survived, dropped } and totals aggregates across all.
export function runBenchmark(dir = FIXTURES_DIR, opts = {}) {
  const match = opts.match ?? 'exact';
  const sessions = [];

  for (const name of readdirSync(dir).sort()) {
    const sessionDir = join(dir, name);
    if (!statSync(sessionDir).isDirectory()) continue;
    const original = readFileSync(join(sessionDir, 'original.md'), 'utf8');
    const compacted = readFileSync(join(sessionDir, 'compacted.md'), 'utf8');
    const { score, total, survived, dropped } = scoreConformance(original, compacted, { match });
    sessions.push({ name, score, total, survived, dropped });
  }

  const total = sessions.reduce((sum, s) => sum + s.total, 0);
  const survived = sessions.reduce((sum, s) => sum + s.survived, 0);
  const retention = total === 0 ? 1 : survived / total;

  return {
    match,
    sessions,
    totals: { total, survived, dropped: total - survived, retention, dropRate: 1 - retention },
  };
}

const pct = (x) => (x * 100).toFixed(1) + '%';

// Render a benchmark result as a human-readable retention table + summary.
export function formatReport(bench) {
  const { sessions, totals, match } = bench;

  const header = ['Session', 'Constraints', 'Survived', 'Dropped', 'Retention', 'Drop'];
  const rows = sessions.map((s) => [
    s.name,
    String(s.total),
    String(s.survived),
    String(s.total - s.survived),
    pct(s.score),
    pct(1 - s.score),
  ]);

  // Column widths from the header and every row; first column left-aligned,
  // the rest right-aligned (they are all counts or percentages).
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');

  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const table = [fmt(header), rule, ...rows.map(fmt)].join('\n');

  return [
    `ConstraintRot reproduction benchmark  (match=${match}, ${sessions.length} sessions)`,
    'Ref: arXiv 2606.22528 — constraint-violation rates jump from 0% to as high as 59% after compaction.',
    '',
    table,
    '',
    `Overall retention: ${pct(totals.retention)}  (${totals.survived}/${totals.total} constraints survived)`,
    `ConstraintRot (dropped after compaction): ${pct(totals.dropRate)}`,
  ].join('\n');
}

function main() {
  const bench = runBenchmark();
  process.stdout.write(formatReport(bench) + '\n');
  if (bench.totals.dropRate === 0) {
    process.stderr.write('note: fixtures show no constraint drop — the benchmark is not reproducing ConstraintRot\n');
  }
}

// Run only when invoked directly (`node bench/bench.js`), not when imported by
// tests. Standard ESM main-module check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
