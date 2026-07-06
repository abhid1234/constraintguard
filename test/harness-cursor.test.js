import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptHarness,
  extractFromHarness,
  HARNESSES,
  validateConstraintSet,
} from '../src/index.js';

// A `.cursorrules` plaintext body carrying one fenced constraint.
const CURSORRULES = [
  '# Project rules',
  '',
  'Always prefer TypeScript.',
  '',
  '```constraints',
  'must [no-secrets]: Never commit secrets to the repository.',
  '```',
  '',
].join('\n');

// An `.mdc` rule: frontmatter, then a body fence.
const MDC = [
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

test('.cursorrules pass-through: mdc:false returns the text unchanged and extracts the fence', () => {
  assert.equal(adaptHarness('cursor', CURSORRULES, { mdc: false }), CURSORRULES);
  const set = extractFromHarness('cursor', CURSORRULES, { mdc: false });
  assert.deepEqual(set, [
    { id: 'no-secrets', text: 'Never commit secrets to the repository.', severity: 'must' },
  ]);
  assert.equal(validateConstraintSet(set), set);
});

test('.mdc frontmatter is stripped and the body fence extracts', () => {
  const body = adaptHarness('cursor', MDC, { mdc: true });
  assert.ok(!body.includes('alwaysApply'), 'frontmatter leaked into the body');
  assert.match(body, /# Security/);
  const set = extractFromHarness('cursor', MDC, { mdc: true });
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
  assert.deepEqual(extractFromHarness('cursor', raw, { mdc: true }), []);
});

test('an .mdc with no closing --- is returned unchanged (body not swallowed)', () => {
  const raw = [
    '---',
    'description: never closed',
    '',
    '```constraints',
    'must [kept]: body survives when frontmatter is unterminated.',
    '```',
    '',
  ].join('\n');
  assert.equal(adaptHarness('cursor', raw, { mdc: true }), raw);
  assert.deepEqual(
    extractFromHarness('cursor', raw, { mdc: true }).map((c) => c.id),
    ['kept'],
  );
});

test('mdc:false leaves a ---leading .cursorrules untouched (extension gates stripping)', () => {
  const raw = [
    '---',
    '',
    '```constraints',
    'must [rule]: a --- horizontal rule is not frontmatter.',
    '```',
    '',
  ].join('\n');
  assert.equal(adaptHarness('cursor', raw, { mdc: false }), raw);
  assert.deepEqual(
    extractFromHarness('cursor', raw, { mdc: false }).map((c) => c.id),
    ['rule'],
  );
});

test('determinism: same input yields identical output, and the set re-validates', () => {
  assert.equal(
    adaptHarness('cursor', MDC, { mdc: true }),
    adaptHarness('cursor', MDC, { mdc: true }),
  );
  const set = extractFromHarness('cursor', MDC, { mdc: true });
  assert.equal(validateConstraintSet(set), set);
});

test('non-string raw throws a clear Error', () => {
  assert.throws(() => adaptHarness('cursor', null), /cursor adapter expects a string/);
  assert.throws(() => adaptHarness('cursor', 42), /cursor adapter expects a string/);
});

test('cursor is a supported harness; an unknown harness names the supported set', () => {
  assert.ok(HARNESSES.includes('cursor'));
  assert.throws(() => adaptHarness('nope', 'x'), (err) => {
    assert.match(err.message, /unknown harness/);
    for (const name of HARNESSES) assert.match(err.message, new RegExp(name));
    return true;
  });
});
