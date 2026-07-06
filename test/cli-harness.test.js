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

test('cg extract --harness claude-code extracts user constraints, exits 0, decoys absent', () => {
  const res = run(['extract', '--harness', 'claude-code', FIXTURE]);
  assert.equal(res.status, 0, res.stderr);
  const set = JSON.parse(res.stdout);
  assert.deepEqual(set, [
    { id: 'no-pii', text: 'Never leak personal data.', severity: 'must' },
    { id: 'keep-replies-concise', text: 'Keep replies concise.', severity: 'should' },
    { id: 'audit-log', text: 'Always write an audit log entry.', severity: 'must' },
  ]);
  assert.ok(!res.stdout.includes('decoy'), 'decoy constraints leaked to output');
});

test('cg extract --harness claude-code tolerates the truncated final line (warns, exits 0)', () => {
  const res = run(['extract', '--harness', 'claude-code', FIXTURE]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /not valid JSON/);
});

test('cg extract --strict --harness claude-code does not crash on a malformed transcript line', () => {
  const path = fixture(
    'partial.jsonl',
    '{"type":"user","message":{"role":"user","content":"```constraints\\nmust [ok]: fine.\\n```"}}\n{ truncated',
  );
  const res = run(['extract', '--strict', '--harness', 'claude-code', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [{ id: 'ok', text: 'fine.', severity: 'must' }]);
});

test('cg extract --harness claude-code with no fence prints [] and a note, exits 0', () => {
  const path = fixture('nofence.jsonl', '{"type":"user","message":{"role":"user","content":"just chatting"}}');
  const res = run(['extract', '--harness', 'claude-code', path]);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assert.match(res.stderr, /no constraints found/);
});

test('cg extract with an unknown harness exits non-zero listing supported harnesses', () => {
  const path = fixture('x.jsonl', '{}');
  const res = run(['extract', '--harness', 'borg', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown harness/);
  assert.match(res.stderr, /text/);
  assert.match(res.stderr, /claude-code/);
});

test('cg extract --harness with no value exits non-zero', () => {
  const res = run(['extract', '--harness']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--harness requires a value/);
});

test('--harness text is byte-for-byte identical to omitting --harness (no #2 regression)', () => {
  const path = fixture('ctx.md', '```constraints\nmust [no-pii]: Never leak PII.\nshould: Keep it short.\n```');
  const bare = run(['extract', path]);
  const explicit = run(['extract', '--harness', 'text', path]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(explicit.stdout, bare.stdout);
  assert.equal(explicit.status, bare.status);
});
