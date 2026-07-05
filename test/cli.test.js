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

test('cg extract prints a valid JSON set to stdout and exits 0', () => {
  const path = fixture(
    'session.md',
    '```constraints\nmust [no-pii]: Never leak PII.\nshould: Keep it short.\n```',
  );
  const res = run(['extract', path]);
  assert.equal(res.status, 0, res.stderr);
  const set = JSON.parse(res.stdout);
  assert.deepEqual(set, [
    { id: 'no-pii', text: 'Never leak PII.', severity: 'must' },
    { id: 'keep-it-short', text: 'Keep it short.', severity: 'should' },
  ]);
});

test('cg extract with no block prints [] to stdout, notes on stderr, exits 0', () => {
  const path = fixture('empty.md', 'no constraints here');
  const res = run(['extract', path]);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assert.match(res.stderr, /no constraints found/);
});

test('cg extract with a missing file argument exits non-zero with a clear message', () => {
  const res = run(['extract']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /context file is required/);
});

test('cg extract on an unreadable file exits non-zero with a clear message', () => {
  const res = run(['extract', '/no/such/file/here.md']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read/);
});

test('cg extract --strict exits non-zero on a malformed line', () => {
  const path = fixture('bad.md', '```constraints\nmust: ok\ngarbage line\n```');
  const res = run(['extract', '--strict', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /extract:/);
});

test('cg with an unknown command exits non-zero', () => {
  const res = run(['frobnicate']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown command/);
});
