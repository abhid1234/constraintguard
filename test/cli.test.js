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

const SET_JSON = JSON.stringify([
  { id: 'no-pii', text: 'Never leak PII.', severity: 'must' },
  { id: 'short', text: 'Keep it short.', severity: 'should' },
]);

test('cg pin with a constraints file writes the pinned context to stdout, exits 0', () => {
  const setPath = fixture('set.json', SET_JSON);
  const ctxPath = fixture('session.md', 'Existing prose.\n');
  const res = run(['pin', setPath, ctxPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.startsWith('```constraints\n'), res.stdout);
  assert.match(res.stdout, /Existing prose\./);
  // Round-trips through extract.
  const back = run(['extract', fixture('pinned.md', res.stdout)]);
  assert.deepEqual(JSON.parse(back.stdout), JSON.parse(SET_JSON));
});

test('cg pin reads the constraint set from stdin when only a context file is given', () => {
  const ctxPath = fixture('session.md', 'body\n');
  const res = run(['pin', ctxPath], { input: SET_JSON });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /must \[no-pii\]: Never leak PII\./);
});

test('cg pin is idempotent when re-run over its own output', () => {
  const setPath = fixture('set.json', SET_JSON);
  const ctxPath = fixture('session.md', 'body text\n');
  const first = run(['pin', setPath, ctxPath]);
  assert.equal(first.status, 0, first.stderr);
  const second = run(['pin', setPath, fixture('pinned.md', first.stdout)]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
});

test('cg pin with no arguments exits non-zero with a clear message', () => {
  const res = run(['pin'], { input: SET_JSON });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /context file is required/);
});

test('cg pin with an invalid constraint set exits non-zero', () => {
  const setPath = fixture('bad.json', '[{"id":"a","text":"x","severity":"maybe"}]');
  const ctxPath = fixture('session.md', 'body\n');
  const res = run(['pin', setPath, ctxPath]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid constraint set/);
});

test('cg pin on an unreadable context file exits non-zero', () => {
  const setPath = fixture('set.json', SET_JSON);
  const res = run(['pin', setPath, '/no/such/context.md']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read/);
});
