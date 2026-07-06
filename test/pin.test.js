import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinConstraints, extractConstraints, validateConstraintSet } from '../src/index.js';

const SET = [
  { id: 'no-pii', text: 'Never include personal data in output.', severity: 'must' },
  { id: 'short', text: 'Prefer the shortest correct answer.', severity: 'should' },
];

test('injects a constraints block at the top, prose below', () => {
  const out = pinConstraints(SET, 'Some prose.');
  assert.match(out, /^```constraints\n/);
  assert.match(out, /Some prose\.$/);
  // The block sits above the prose.
  assert.ok(out.indexOf('```constraints') < out.indexOf('Some prose.'));
});

test('round-trips through extract: same constraints, ids, and order', () => {
  const out = pinConstraints(SET, 'context prose');
  assert.deepEqual(extractConstraints(out), SET);
});

test('explicit ids survive even when they are not the slug of the text', () => {
  // slug('Never log secrets') would be 'never-log-secrets'; the explicit id `c1`
  // must be preserved, proving the explicit [id] form is emitted.
  const set = [{ id: 'c1', text: 'Never log secrets', severity: 'must' }];
  const out = pinConstraints(set, 'ctx');
  assert.match(out, /must \[c1\]: Never log secrets/);
  assert.deepEqual(extractConstraints(out), set);
});

test('empty set emits an empty block that extracts back to []', () => {
  const out = pinConstraints([], 'ctx');
  assert.match(out, /```constraints\n```/);
  assert.deepEqual(extractConstraints(out), []);
});

test('wholesale replace: an existing block is replaced, not merged', () => {
  const ctx = [
    '```constraints',
    'must [old]: An old rule that must not survive.',
    '```',
    '',
    'body prose',
  ].join('\n');
  const out = pinConstraints(SET, ctx);
  // Exactly one constraints fence remains.
  assert.equal((out.match(/```constraints/g) || []).length, 1);
  // And it holds exactly the new set — the old constraint is gone, not merged.
  assert.deepEqual(extractConstraints(out), SET);
  assert.ok(!out.includes('An old rule'));
});

test('idempotent: pinning twice with the same set is byte-for-byte identical', () => {
  const ctx = 'intro\n\n```constraints\nmust [old]: stale\n```\n\ntail';
  const once = pinConstraints(SET, ctx);
  const twice = pinConstraints(SET, once);
  assert.equal(twice, once);
  assert.equal((twice.match(/```constraints/g) || []).length, 1);
});

test('deterministic: same inputs yield the identical string', () => {
  assert.equal(pinConstraints(SET, 'ctx'), pinConstraints(SET, 'ctx'));
});

test('invalid set throws (via validateConstraintSet)', () => {
  const dupes = [
    { id: 'x', text: 'a', severity: 'must' },
    { id: 'x', text: 'b', severity: 'should' },
  ];
  assert.throws(() => pinConstraints(dupes, 'ctx'), /duplicate/);
  assert.throws(() => pinConstraints([{ id: 'y', text: 'z', severity: 'nope' }], 'ctx'), /severity/);
});

test('non-encodable constraint throws (newline in text, "]" in id)', () => {
  assert.throws(
    () => pinConstraints([{ id: 'ok', text: 'line one\nline two', severity: 'must' }], 'ctx'),
    /line break/,
  );
  assert.throws(
    () => pinConstraints([{ id: 'bad]id', text: 'fine', severity: 'must' }], 'ctx'),
    /cannot be pinned/,
  );
});

test('empty and no-fence contexts: block alone, or block above the text', () => {
  const alone = pinConstraints(SET, '');
  assert.equal(alone, '```constraints\nmust [no-pii]: Never include personal data in output.\nshould [short]: Prefer the shortest correct answer.\n```\n');
  const above = pinConstraints(SET, 'plain text with no fence');
  assert.match(above, /```\n\nplain text with no fence$/);
});

test('output is always a valid, extractable set', () => {
  assert.equal(validateConstraintSet(extractConstraints(pinConstraints(SET, 'ctx'))).length, 2);
});
