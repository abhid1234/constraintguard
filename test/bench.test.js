import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBenchmark, formatReport, FIXTURES_DIR } from '../bench/bench.js';

const BENCH = fileURLToPath(new URL('../bench/bench.js', import.meta.url));

const block = (lines) => '```constraints\n' + lines.join('\n') + '\n```';

// Build a throwaway fixtures dir with one session per {name, original, compacted}.
function fixtures(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'cg-bench-'));
  for (const s of sessions) {
    const dir = join(root, s.name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'original.md'), s.original);
    writeFileSync(join(dir, 'compacted.md'), s.compacted);
  }
  return root;
}

test('runBenchmark scores each session and aggregates the totals', () => {
  const dir = fixtures([
    {
      name: '01-a',
      original: block(['must [a]: keep a', 'must [b]: keep b', 'should [c]: drop c']),
      compacted: block(['must [a]: keep a', 'must [b]: keep b']), // 2/3
    },
    {
      name: '02-b',
      original: block(['must [x]: keep x', 'must [y]: drop y']),
      compacted: block(['must [x]: keep x']), // 1/2
    },
  ]);

  const bench = runBenchmark(dir);
  assert.equal(bench.match, 'exact');
  assert.equal(bench.sessions.length, 2);
  assert.equal(bench.sessions[0].name, '01-a');
  assert.equal(bench.sessions[0].score, 2 / 3);
  assert.equal(bench.sessions[1].score, 1 / 2);

  // total = 3 + 2 = 5, survived = 2 + 1 = 3.
  assert.equal(bench.totals.total, 5);
  assert.equal(bench.totals.survived, 3);
  assert.equal(bench.totals.dropped, 2);
  assert.equal(bench.totals.retention, 3 / 5);
  assert.equal(bench.totals.dropRate, 1 - 3 / 5);
});

test('runBenchmark ignores loose files, only reads session directories', () => {
  const dir = fixtures([
    { name: '01-a', original: block(['must [a]: keep a']), compacted: block(['must [a]: keep a']) },
  ]);
  writeFileSync(join(dir, 'README.md'), 'not a session');

  const bench = runBenchmark(dir);
  assert.equal(bench.sessions.length, 1);
});

test('committed fixtures reproduce a measurable ConstraintRot drop', () => {
  const bench = runBenchmark(FIXTURES_DIR);
  assert.ok(bench.sessions.length >= 3, 'ships several sample sessions');
  // Every session declares constraints and the aggregate loses some of them.
  assert.ok(bench.totals.total > 0);
  assert.ok(bench.totals.dropRate > 0, 'compaction drops at least one constraint');
  assert.ok(bench.totals.retention < 1, 'retention is below a perfect score');
  assert.ok(bench.totals.retention > 0, 'not everything is dropped');
});

test('formatReport renders a retention table with a header and summary', () => {
  const bench = runBenchmark(FIXTURES_DIR);
  const report = formatReport(bench);
  assert.match(report, /Session {2,}Constraints {2,}Survived {2,}Dropped {2,}Retention {2,}Drop/);
  assert.match(report, /Overall retention: \d+\.\d%/);
  assert.match(report, /ConstraintRot \(dropped after compaction\): \d+\.\d%/);
  for (const s of bench.sessions) assert.ok(report.includes(s.name));
});

test('npm run bench script runs, exits 0, and prints the drop', () => {
  const res = spawnSync(process.execPath, [BENCH], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ConstraintRot reproduction benchmark/);
  assert.match(res.stdout, /ConstraintRot \(dropped after compaction\): \d+\.\d%/);
});
