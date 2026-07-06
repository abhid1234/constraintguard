import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CG = fileURLToPath(new URL('../bin/cg.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/claude-code-session.jsonl', import.meta.url));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CG, ...args], { encoding: 'utf8', ...opts });
}

function fixture(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-test-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test('cg extract --harness claude-code extracts the declared set from a transcript', () => {
  const res = run(['extract', '--harness', 'claude-code', FIXTURE]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [
    { id: 'no-secrets', text: 'Never commit secrets to the repository.', severity: 'must' },
    { id: 'prefer-the-smallest-cohesive-change', text: 'Prefer the smallest cohesive change.', severity: 'should' },
    { id: 'no-force-push', text: 'Never force-push to the main branch.', severity: 'must' },
  ]);
});

test('cg extract defaults to the text passthrough harness', () => {
  const path = fixture('session.md', '```constraints\nmust: Keep it.\n```');
  const res = run(['extract', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [{ id: 'keep-it', text: 'Keep it.', severity: 'must' }]);
});

test('cg extract --harness text is an explicit passthrough (same as default)', () => {
  const path = fixture('session.md', '```constraints\nmust [x]: A rule.\n```');
  const res = run(['extract', '--harness', 'text', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [{ id: 'x', text: 'A rule.', severity: 'must' }]);
});

test('cg extract with an unknown harness exits non-zero with a clear message', () => {
  const res = run(['extract', '--harness', 'codex', FIXTURE]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown harness/);
});

test('cg extract --harness without a value exits non-zero with usage', () => {
  const res = run(['extract', '--harness']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--harness requires a value/);
});

test('cg extract --harness claude-code --strict fails on a malformed transcript line', () => {
  const path = fixture('bad.jsonl', '{ not json\n{"type":"user","message":{"role":"user","content":"ok"}}');
  const res = run(['extract', '--harness', 'claude-code', '--strict', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /extract:.*not valid JSON/);
});

test('cg extract --harness claude-code on a transcript with no constraints notes and exits 0', () => {
  const path = fixture('plain.jsonl', '{"type":"user","message":{"role":"user","content":"just chatting"}}');
  const res = run(['extract', '--harness', 'claude-code', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assert.match(res.stderr, /no constraints found/);
});
