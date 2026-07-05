import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CG = fileURLToPath(new URL('../bin/cg.js', import.meta.url));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CG, ...args], { encoding: 'utf8', ...opts });
}

function fixture(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-test-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const block = (lines) => '```constraints\n' + lines.join('\n') + '\n```';

// A fixture pair scoring 0.75 (3 of 4 original constraints survive).
function pair075() {
  const original = fixture(
    'original.md',
    block([
      'must [no-pii]: Never include personal data in output.',
      'must [cite]: Cite your sources.',
      'should [terse]: Keep it short.',
      'must [safe]: Refuse unsafe requests.',
    ]),
  );
  const compacted = fixture(
    'compacted.md',
    block([
      'must [cite]: Cite your sources.',
      'should [terse]: Keep it short.',
      'must [safe]: Refuse unsafe requests.',
    ]),
  );
  return { original, compacted };
}

test('conformance prints the human report with a Dropped section and exits 0', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Conformance: 0\.75 {2}\(3\/4 constraints survived\)/);
  assert.match(res.stdout, /Dropped \(1\):/);
  assert.match(res.stdout, /- must \[no-pii\]: Never include personal data in output\./);
});

test('conformance with nothing dropped prints no Dropped section', () => {
  const ctx = block(['must [a]: One.', 'should [b]: Two.']);
  const original = fixture('o.md', ctx);
  const compacted = fixture('c.md', ctx);
  const res = run(['conformance', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Conformance: 1\.00 {2}\(2\/2 constraints survived\)/);
  assert.doesNotMatch(res.stdout, /Dropped/);
});

test('conformance --json prints the result object and exits 0', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', '--json', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.score, 0.75);
  assert.equal(out.total, 4);
  assert.equal(out.survived, 3);
  assert.deepEqual(out.dropped, [
    { id: 'no-pii', text: 'Never include personal data in output.', severity: 'must' },
  ]);
});

test('conformance with no constraints in the original notes 0/0 and exits 0', () => {
  const original = fixture('o.md', 'nothing declared here');
  const compacted = fixture('c.md', block(['must: added later']));
  const res = run(['conformance', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Conformance: 1\.00 {2}\(0\/0\) — no constraints declared/);
});

test('conformance --threshold passes (exit 0) when score >= t', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', '--threshold', '0.5', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Conformance: 0\.75/);
});

test('conformance --threshold fails with exit 2 when score < t, still printing the report', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', '--threshold', '0.9', original, compacted]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /Conformance: 0\.75/);
});

test('conformance --threshold with --json still exits 2 on a failing gate', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', '--json', '--threshold', '0.9', original, compacted]);
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).score, 0.75);
});

test('conformance --match id survives a reword', () => {
  const original = fixture('o.md', block(['must [no-pii]: Never leak PII.']));
  const compacted = fixture('c.md', block(['must [no-pii]: Do not include personal data.']));
  const res = run(['conformance', '--match', 'id', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Conformance: 1\.00/);
});

test('conformance --strict exits 1 on a malformed constraint line', () => {
  const original = fixture('o.md', '```constraints\nmust: ok\ngarbage line\n```');
  const compacted = fixture('c.md', block(['must: ok']));
  const res = run(['conformance', '--strict', original, compacted]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /conformance:/);
});

test('conformance routes extraction warnings to stderr tagged by source file', () => {
  const original = fixture('original.md', '```constraints\nmust: ok\ngarbage line\n```');
  const compacted = fixture('compacted.md', block(['must: ok']));
  const res = run(['conformance', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /warning: .*original\.md: /);
});

test('conformance with a missing second file argument exits 1', () => {
  const only = fixture('o.md', block(['must: ok']));
  const res = run(['conformance', only]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /expected <original> <compacted>/);
});

test('conformance on an unreadable file exits 1 with a clear message', () => {
  const ok = fixture('o.md', block(['must: ok']));
  const res = run(['conformance', ok, '/no/such/file/here.md']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read/);
});

test('conformance with an out-of-range threshold exits 1', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', '--threshold', '2', original, compacted]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /threshold must be a number in \[0, 1\]/);
});

test('conformance with an unknown option exits 1', () => {
  const { original, compacted } = pair075();
  const res = run(['conformance', '--bogus', original, compacted]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown option/);
});
