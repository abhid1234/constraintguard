import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinConstraints, extractConstraints, validateConstraintSet } from '../src/index.js';

const SET = [
  { id: 'no-pii', text: 'Never include personal data in output.', severity: 'must' },
  { id: 'short', text: 'Prefer the shortest correct answer.', severity: 'should' },
];

test('injects a constraints block at the top of the context', () => {
  const out = pinConstraints(SET, 'Existing prose.\n');
  assert.ok(out.startsWith('```constraints\n'), out);
  assert.match(out, /Existing prose\./);
});

test('round-trips: extract(pin(set, ctx)) equals set, order and ids included', () => {
  const out = pinConstraints(SET, 'Some intro.\n');
  assert.deepEqual(extractConstraints(out), SET);
});

test('emits explicit ids so generated-slug ids survive the round-trip', () => {
  // A set whose ids do NOT match extract's slug of the text.
  const set = [{ id: 'x1', text: 'Never log secrets.', severity: 'must' }];
  const out = pinConstraints(set, '');
  assert.match(out, /must \[x1\]: Never log secrets\./);
  assert.deepEqual(extractConstraints(out), set);
});

test('empty context yields just the block', () => {
  const out = pinConstraints(SET, '');
  assert.deepEqual(extractConstraints(out), SET);
  assert.ok(!out.includes('\n\n'), out); // no dangling body separator
});

test('idempotent: pinning twice does not duplicate the block', () => {
  const once = pinConstraints(SET, 'body text\nmore body\n');
  const twice = pinConstraints(SET, once);
  assert.equal(twice, once);
  // Exactly one constraints block survives.
  assert.deepEqual(extractConstraints(twice), SET);
});

test('replaces a pre-existing constraints block rather than appending', () => {
  const ctx = [
    'prose before',
    '```constraints',
    'must: An old rule that should be replaced.',
    '```',
    'prose after',
  ].join('\n');
  const out = pinConstraints(SET, ctx);
  assert.deepEqual(extractConstraints(out), SET);
  assert.ok(!out.includes('An old rule'), out);
  assert.match(out, /prose before/);
  assert.match(out, /prose after/);
});

test('replaces multiple pre-existing blocks with a single one', () => {
  const ctx = '```constraints\nmust: a\n```\nmid\n~~~constraints\nshould: b\n~~~\nend';
  const out = pinConstraints(SET, ctx);
  assert.deepEqual(extractConstraints(out), SET);
  assert.match(out, /mid/);
  assert.match(out, /end/);
});

test('output is deterministic', () => {
  assert.equal(pinConstraints(SET, 'ctx'), pinConstraints(SET, 'ctx'));
});

test('returned block always satisfies the #1 schema on extract', () => {
  const set = extractConstraints(pinConstraints(SET, 'anything'));
  assert.equal(validateConstraintSet(set), set);
});

test('an empty set pins an empty block and round-trips to []', () => {
  const out = pinConstraints([], 'prose\n');
  assert.deepEqual(extractConstraints(out), []);
});

test('non-string context throws', () => {
  assert.throws(() => pinConstraints(SET, null), /expects a string/);
  assert.throws(() => pinConstraints(SET, 42), /expects a string/);
});

test('non-encodable constraint throws (schema-valid but breaks the round-trip)', () => {
  // Embedded newline in text would split into a non-constraint physical line.
  assert.throws(
    () => pinConstraints([{ id: 'a', text: 'line one\nline two', severity: 'must' }], 'ctx'),
    /"a".*non-encodable text/,
  );
  // A "]" in the id breaks the [id]: delimiter so extract cannot read it back.
  assert.throws(
    () => pinConstraints([{ id: 'a]b', text: 'x', severity: 'must' }], 'ctx'),
    /"a\]b".*non-encodable id/,
  );
});

test('an invalid constraint set throws (validated with #1)', () => {
  assert.throws(() => pinConstraints([{ id: 'a', text: 'x', severity: 'maybe' }], 'ctx'), /severity/);
  assert.throws(() => pinConstraints('not an array', 'ctx'), /must be an array/);
});
