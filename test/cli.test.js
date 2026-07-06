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

const PIN_SET = [
  { id: 'no-pii', text: 'Never leak PII.', severity: 'must' },
  { id: 'short', text: 'Keep it short.', severity: 'should' },
];

test('cg pin <json> <ctx> prints the pinned context; extracting it yields the set', () => {
  const jsonPath = fixture('constraints.json', JSON.stringify(PIN_SET));
  const ctxPath = fixture('ctx.md', 'some context prose');
  const res = run(['pin', jsonPath, ctxPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /```constraints/);
  // Round-trip: re-extract the pinned stdout by piping it back through `cg extract`.
  const pinnedPath = fixture('pinned.md', res.stdout);
  const back = run(['extract', pinnedPath]);
  assert.equal(back.status, 0, back.stderr);
  assert.deepEqual(JSON.parse(back.stdout), PIN_SET);
});

test('cg pin - <ctx> reads the constraint set from stdin (extract | pin round-trip)', () => {
  const ctxPath = fixture('ctx.md', 'compacted context');
  const res = run(['pin', '-', ctxPath], { input: JSON.stringify(PIN_SET) });
  assert.equal(res.status, 0, res.stderr);
  const pinnedPath = fixture('pinned.md', res.stdout);
  const back = run(['extract', pinnedPath]);
  assert.deepEqual(JSON.parse(back.stdout), PIN_SET);
});

test('cg pin with invalid JSON exits non-zero with a clear message', () => {
  const jsonPath = fixture('bad.json', '{ not valid json');
  const ctxPath = fixture('ctx.md', 'ctx');
  const res = run(['pin', jsonPath, ctxPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid JSON/);
});

test('cg pin with a schema-invalid set exits non-zero and writes no output', () => {
  const jsonPath = fixture('invalid.json', JSON.stringify([{ id: 'x', text: 'y', severity: 'nope' }]));
  const ctxPath = fixture('ctx.md', 'ctx');
  const res = run(['pin', jsonPath, ctxPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /severity/);
  assert.equal(res.stdout, '');
});

test('cg pin on an unreadable context file exits non-zero with a clear message', () => {
  const jsonPath = fixture('constraints.json', JSON.stringify(PIN_SET));
  const res = run(['pin', jsonPath, '/no/such/ctx.md']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read/);
});

test('cg pin with missing arguments exits non-zero with usage', () => {
  const jsonPath = fixture('constraints.json', JSON.stringify(PIN_SET));
  assert.equal(run(['pin']).status, 1);
  assert.match(run(['pin']).stderr, /required|usage/);
  assert.equal(run(['pin', jsonPath]).status, 1);
});
