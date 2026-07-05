import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreConformance } from '../src/conformance.js';

const block = (lines) => '```constraints\n' + lines.join('\n') + '\n```';

test('perfect retention: identical contexts score 1', () => {
  const ctx = block(['must [no-pii]: Never leak PII.', 'should: Keep it short.']);
  const res = scoreConformance(ctx, ctx);
  assert.deepEqual(res, { score: 1, total: 2, survived: 2, dropped: [] });
});

test('partial drop: a missing constraint lands in dropped, in document order', () => {
  const original = block([
    'must [no-pii]: Never leak PII.',
    'should [terse]: Keep it short.',
    'must [cite]: Cite your sources.',
  ]);
  const compacted = block(['must [no-pii]: Never leak PII.', 'must [cite]: Cite your sources.']);
  const res = scoreConformance(original, compacted);
  assert.equal(res.total, 3);
  assert.equal(res.survived, 2);
  assert.equal(res.score, 2 / 3);
  assert.deepEqual(res.dropped, [{ id: 'terse', text: 'Keep it short.', severity: 'should' }]);
});

test('total === 0: no constraints in the original is a vacuous perfect score', () => {
  const res = scoreConformance('no constraints here', block(['must: something added']));
  assert.deepEqual(res, { score: 1, total: 0, survived: 0, dropped: [] });
});

test('exact match: a reworded text counts as dropped', () => {
  const original = block(['must [no-pii]: Never leak PII.']);
  const compacted = block(['must [no-pii]: Do not include personal data.']);
  const res = scoreConformance(original, compacted);
  assert.equal(res.survived, 0);
  assert.deepEqual(res.dropped, [{ id: 'no-pii', text: 'Never leak PII.', severity: 'must' }]);
});

test('exact match: a must→should severity downgrade counts as dropped', () => {
  const original = block(['must [no-pii]: Never leak PII.']);
  const compacted = block(['should [no-pii]: Never leak PII.']);
  const res = scoreConformance(original, compacted);
  assert.equal(res.survived, 0);
  assert.deepEqual(res.dropped, [{ id: 'no-pii', text: 'Never leak PII.', severity: 'must' }]);
});

test('--match id: a reworded text with a stable id survives', () => {
  const original = block(['must [no-pii]: Never leak PII.']);
  const compacted = block(['must [no-pii]: Do not include personal data.']);
  const res = scoreConformance(original, compacted, { match: 'id' });
  assert.deepEqual(res, { score: 1, total: 1, survived: 1, dropped: [] });
});

test('determinism: two calls on the same inputs are deep-equal', () => {
  const original = block(['must [a]: One.', 'should [b]: Two.']);
  const compacted = block(['must [a]: One.']);
  assert.deepEqual(
    scoreConformance(original, compacted),
    scoreConformance(original, compacted),
  );
});

test('strict propagates: a malformed line in either context throws', () => {
  const good = block(['must [a]: One.']);
  const bad = '```constraints\nmust: ok\ngarbage line\n```';
  assert.throws(() => scoreConformance(bad, good, { strict: true }));
  assert.throws(() => scoreConformance(good, bad, { strict: true }));
});

test('onWarning is tagged by source context', () => {
  const good = block(['must [a]: One.']);
  const bad = '```constraints\nmust: ok\ngarbage line\n```';
  const sources = [];
  scoreConformance(bad, good, { onWarning: (_msg, source) => sources.push(source) });
  assert.ok(sources.includes('original'));
});

test('unknown match mode throws', () => {
  assert.throws(() => scoreConformance('', '', { match: 'fuzzy' }), /unknown match mode/);
});
