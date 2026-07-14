import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptHarness,
  extractFromHarness,
  HARNESSES,
  validateConstraintSet,
} from '../src/index.js';

// A plain Antigravity `AGENTS.md` rules file carrying one fenced constraint.
const AGENTS_MD = [
  '# Agent rules',
  '',
  'Always prefer TypeScript.',
  '',
  '```constraints',
  'must [no-secrets]: Never commit secrets to the repository.',
  '```',
  '',
].join('\n');

// A rule file with a leading YAML frontmatter block, then a body fence.
const WITH_FRONTMATTER = [
  '---',
  'description: Security rules',
  'alwaysApply: true',
  '---',
  '',
  '# Security',
  '',
  '```constraints',
  'must [audit-log]: Always write an audit log entry.',
  '```',
  '',
].join('\n');

test('AGENTS.md pass-through: frontmatter:false returns the text unchanged and extracts the fence', () => {
  assert.equal(adaptHarness('antigravity', AGENTS_MD, { frontmatter: false }), AGENTS_MD);
  const set = extractFromHarness('antigravity', AGENTS_MD, { frontmatter: false });
  assert.deepEqual(set, [
    { id: 'no-secrets', text: 'Never commit secrets to the repository.', severity: 'must' },
  ]);
  assert.equal(validateConstraintSet(set), set);
});

test('the generic (no-opts) path is a pass-through, matching CLI single-file reads', () => {
  assert.equal(adaptHarness('antigravity', AGENTS_MD), AGENTS_MD);
  assert.deepEqual(
    extractFromHarness('antigravity', AGENTS_MD).map((c) => c.id),
    ['no-secrets'],
  );
});

test('frontmatter is stripped when requested and the body fence extracts', () => {
  const body = adaptHarness('antigravity', WITH_FRONTMATTER, { frontmatter: true });
  assert.ok(!body.includes('alwaysApply'), 'frontmatter leaked into the body');
  assert.match(body, /# Security/);
  const set = extractFromHarness('antigravity', WITH_FRONTMATTER, { frontmatter: true });
  assert.deepEqual(set, [
    { id: 'audit-log', text: 'Always write an audit log entry.', severity: 'must' },
  ]);
});

test('a constraints fence inside the frontmatter is excluded after stripping', () => {
  const raw = [
    '---',
    'description: |',
    '  ```constraints',
    '  must [decoy]: must not be extracted.',
    '  ```',
    'alwaysApply: true',
    '---',
    '',
    '# Body has no fence.',
    '',
  ].join('\n');
  assert.deepEqual(extractFromHarness('antigravity', raw, { frontmatter: true }), []);
});

test('an unterminated frontmatter block is returned unchanged (body not swallowed)', () => {
  const raw = [
    '---',
    'description: never closed',
    '',
    '```constraints',
    'must [kept]: body survives when frontmatter is unterminated.',
    '```',
    '',
  ].join('\n');
  assert.equal(adaptHarness('antigravity', raw, { frontmatter: true }), raw);
  assert.deepEqual(
    extractFromHarness('antigravity', raw, { frontmatter: true }).map((c) => c.id),
    ['kept'],
  );
});

test('frontmatter:false leaves a ---leading AGENTS.md untouched (a --- rule is not frontmatter)', () => {
  const raw = [
    '---',
    '',
    '```constraints',
    'must [rule]: a --- horizontal rule is not frontmatter.',
    '```',
    '',
  ].join('\n');
  assert.equal(adaptHarness('antigravity', raw, { frontmatter: false }), raw);
  assert.deepEqual(
    extractFromHarness('antigravity', raw, { frontmatter: false }).map((c) => c.id),
    ['rule'],
  );
});

test('determinism: same input yields identical output, and the set re-validates', () => {
  assert.equal(
    adaptHarness('antigravity', WITH_FRONTMATTER, { frontmatter: true }),
    adaptHarness('antigravity', WITH_FRONTMATTER, { frontmatter: true }),
  );
  const set = extractFromHarness('antigravity', WITH_FRONTMATTER, { frontmatter: true });
  assert.equal(validateConstraintSet(set), set);
});

test('non-string raw throws a clear Error', () => {
  assert.throws(() => adaptHarness('antigravity', null), /antigravity adapter expects a string/);
  assert.throws(() => adaptHarness('antigravity', 42), /antigravity adapter expects a string/);
});

test('antigravity is a supported harness listed in HARNESSES', () => {
  assert.ok(HARNESSES.includes('antigravity'));
});
