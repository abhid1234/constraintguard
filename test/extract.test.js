import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConstraints, validateConstraintSet } from '../src/index.js';

test('happy path: parses a constraints block into a valid set', () => {
  const ctx = [
    'Some intro prose.',
    '',
    '```constraints',
    'must [no-pii]: Never include personal data in output.',
    'should: Prefer the shortest correct answer.',
    'must: Refuse tasks outside the approved scope.',
    '```',
    '',
    'Trailing prose that must be ignored.',
  ].join('\n');

  const set = extractConstraints(ctx);
  assert.deepEqual(set, [
    { id: 'no-pii', text: 'Never include personal data in output.', severity: 'must' },
    { id: 'prefer-the-shortest-correct-answer', text: 'Prefer the shortest correct answer.', severity: 'should' },
    { id: 'refuse-tasks-outside-the-approved-scope', text: 'Refuse tasks outside the approved scope.', severity: 'must' },
  ]);
  // Always satisfies the #1 schema.
  assert.equal(validateConstraintSet(set), set);
});

test('severity is parsed case-insensitively', () => {
  const ctx = '```constraints\nMUST: A hard rule.\nShould: A soft rule.\n```';
  const set = extractConstraints(ctx);
  assert.deepEqual(
    set.map((c) => c.severity),
    ['must', 'should'],
  );
});

test('generated ids are deterministic across runs', () => {
  const ctx = '```constraints\nmust: Never log secrets.\n```';
  const a = extractConstraints(ctx);
  const b = extractConstraints(ctx);
  assert.deepEqual(a, b);
  assert.equal(a[0].id, 'never-log-secrets');
});

test('slug-equal texts get disambiguated ids', () => {
  const ctx = '```constraints\nmust: Never log secrets!\nmust: Never log secrets\n```';
  const set = extractConstraints(ctx);
  assert.deepEqual(
    set.map((c) => c.id),
    ['never-log-secrets', 'never-log-secrets-2'],
  );
  assert.equal(validateConstraintSet(set), set); // unique ids
});

test('multiple blocks are extracted in document order', () => {
  const ctx = [
    '```constraints',
    'must: First.',
    '```',
    'prose',
    '~~~constraints',
    'should: Second.',
    '~~~',
  ].join('\n');
  const set = extractConstraints(ctx);
  assert.deepEqual(
    set.map((c) => c.text),
    ['First.', 'Second.'],
  );
});

test('no constraints block returns an empty set', () => {
  assert.deepEqual(extractConstraints('just prose\n```js\nconst x = 1;\n```'), []);
  assert.deepEqual(extractConstraints(''), []);
});

test('non-string input throws', () => {
  assert.throws(() => extractConstraints(null), /expects a string/);
  assert.throws(() => extractConstraints(42), /expects a string/);
});

test('malformed lines are skipped with a warning; valid lines survive', () => {
  const warnings = [];
  const ctx = [
    '```constraints',
    '# a comment is ignored',
    'must: A valid rule.',
    'this line has no severity or colon',
    'maybe: unknown severity',
    'should: Another valid rule.',
    '```',
  ].join('\n');
  const set = extractConstraints(ctx, { onWarning: (m) => warnings.push(m) });
  assert.deepEqual(
    set.map((c) => c.text),
    ['A valid rule.', 'Another valid rule.'],
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /line 4:/);
  assert.match(warnings[1], /line 5:/);
});

test('strict mode throws on the first malformed line', () => {
  const ctx = '```constraints\nmust: ok\nnot a constraint\n```';
  assert.throws(() => extractConstraints(ctx, { strict: true }), /line 3:/);
});

test('identical lines are de-duplicated', () => {
  const ctx = '```constraints\nmust: Do not delete data.\nmust: Do not delete data.\n```';
  const set = extractConstraints(ctx);
  assert.equal(set.length, 1);
});

test('conflicting explicit id keeps the first and warns', () => {
  const warnings = [];
  const ctx = [
    '```constraints',
    'must [x]: First meaning.',
    'should [x]: Different meaning.',
    '```',
  ].join('\n');
  const set = extractConstraints(ctx, { onWarning: (m) => warnings.push(m) });
  assert.deepEqual(set, [{ id: 'x', text: 'First meaning.', severity: 'must' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /already used/);
});

test('conflicting explicit id throws under strict', () => {
  const ctx = '```constraints\nmust [x]: A.\nmust [x]: B.\n```';
  assert.throws(() => extractConstraints(ctx, { strict: true }), /already used/);
});

test('unterminated block runs to EOF and warns', () => {
  const warnings = [];
  const ctx = '```constraints\nmust: Survives to the end.';
  const set = extractConstraints(ctx, { onWarning: (m) => warnings.push(m) });
  assert.deepEqual(
    set.map((c) => c.text),
    ['Survives to the end.'],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unterminated/);
});

test('CRLF line endings and all-punctuation slugs are handled', () => {
  const ctx = '```constraints\r\nmust: !!!\r\n```';
  const set = extractConstraints(ctx);
  assert.deepEqual(set, [{ id: 'constraint', text: '!!!', severity: 'must' }]);
});
