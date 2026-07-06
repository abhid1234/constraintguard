import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConstraintSet } from '../src/index.js';

const CG = fileURLToPath(new URL('../bin/cg.js', import.meta.url));
const PROJECT = fileURLToPath(new URL('./fixtures/cursor/project', import.meta.url));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CG, ...args], { encoding: 'utf8', ...opts });
}

test('file happy path: --harness cursor <.cursorrules> extracts the fence, exit 0', () => {
  const res = run(['extract', '--harness', 'cursor', join(PROJECT, '.cursorrules')]);
  assert.equal(res.status, 0, res.stderr);
  const set = JSON.parse(res.stdout);
  assert.deepEqual(set, [
    { id: 'no-secrets', text: 'Never commit secrets or credentials to the repository.', severity: 'must' },
  ]);
  assert.equal(validateConstraintSet(set), set);
});

test('.mdc file: the body fence extracts', () => {
  const res = run(['extract', '--harness', 'cursor', join(PROJECT, '.cursor/rules/security.mdc')]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [
    { id: 'audit-log', text: 'Always write an audit log entry for privileged actions.', severity: 'must' },
  ]);
});

test('.mdc frontmatter-decoy file: fence inside frontmatter yields [], exit 0', () => {
  const res = run(['extract', '--harness', 'cursor', join(PROJECT, '.cursor/rules/frontmatter-decoy.mdc')]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assert.match(res.stderr, /no constraints found/);
});

test('directory walk: union of .cursorrules + .cursor/rules/*.mdc, sorted order, decoys absent', () => {
  const res = run(['extract', '--harness', 'cursor', PROJECT]);
  assert.equal(res.status, 0, res.stderr);
  const set = JSON.parse(res.stdout);
  // .cursorrules first, then .mdc files sorted: frontmatter-decoy, no-fence,
  // security, style → only audit-log and tabs carry real body fences.
  assert.deepEqual(set, [
    { id: 'no-secrets', text: 'Never commit secrets or credentials to the repository.', severity: 'must' },
    { id: 'audit-log', text: 'Always write an audit log entry for privileged actions.', severity: 'must' },
    { id: 'tabs', text: 'Indent with tabs, not spaces.', severity: 'should' },
  ]);
  assert.ok(!res.stdout.includes('decoy'), 'frontmatter decoy leaked to output');
  assert.equal(validateConstraintSet(set), set);
});

test('directory walk is deterministic across invocations', () => {
  const a = run(['extract', '--harness', 'cursor', PROJECT]);
  const b = run(['extract', '--harness', 'cursor', PROJECT]);
  assert.equal(a.stdout, b.stdout);
});

test('empty directory: no rule sources → [], exit 0, stderr note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-cursor-empty-'));
  const res = run(['extract', '--harness', 'cursor', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assert.match(res.stderr, /no Cursor rule sources found/);
});

test('no-fence project: rule files present but no fence → [], exit 0, note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-cursor-nofence-'));
  writeFileSync(join(dir, '.cursorrules'), 'Always use TypeScript. No fence here.\n');
  mkdirSync(join(dir, '.cursor', 'rules'), { recursive: true });
  writeFileSync(join(dir, '.cursor', 'rules', 'a.mdc'), '---\nalwaysApply: true\n---\n\nJust prose.\n');
  const res = run(['extract', '--harness', 'cursor', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), []);
  assert.match(res.stderr, /no constraints found/);
});

test('missing path: exit non-zero with a clear message', () => {
  const res = run(['extract', '--harness', 'cursor', join(tmpdir(), 'cg-cursor-does-not-exist-xyz')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /extract: cannot read/);
});

test('unknown harness exits non-zero listing supported harnesses including cursor', () => {
  const res = run(['extract', '--harness', 'borg', join(PROJECT, '.cursorrules')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown harness/);
  assert.match(res.stderr, /cursor/);
});
