import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constraintsToSpanAttributes, conformanceToSpanAttributes } from '../src/otel.js';

// True when `v` is directly OTel-attribute-legal: a string, a finite number, a
// boolean, or a homogeneous array of those. No nested objects, null, undefined.
function isOtelLegal(v) {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return true;
    const t = typeof v[0];
    return (t === 'string' || t === 'number' || t === 'boolean') && v.every((e) => typeof e === t);
  }
  return false;
}

function assertAllLegal(attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    assert.ok(isOtelLegal(v), `value for ${k} is not OTel-legal: ${JSON.stringify(v)}`);
  }
}

test('constraints: non-empty set maps to the four keys with a severity split', () => {
  const set = [
    { id: 'no-pii', text: 'Never leak PII.', severity: 'must' },
    { id: 'cite', text: 'Cite your sources.', severity: 'must' },
    { id: 'terse', text: 'Keep it short.', severity: 'should' },
  ];
  const attrs = constraintsToSpanAttributes(set);
  assert.deepEqual(attrs, {
    'constraintguard.constraints.count': 3,
    'constraintguard.constraints.ids': ['no-pii', 'cite', 'terse'],
    'constraintguard.constraints.severity.must': 2,
    'constraintguard.constraints.severity.should': 1,
  });
  // must + should === count.
  assert.equal(
    attrs['constraintguard.constraints.severity.must'] +
      attrs['constraintguard.constraints.severity.should'],
    attrs['constraintguard.constraints.count'],
  );
});

test('constraints: empty set is the zeroed four-key object, never {}', () => {
  const attrs = constraintsToSpanAttributes([]);
  assert.deepEqual(attrs, {
    'constraintguard.constraints.count': 0,
    'constraintguard.constraints.ids': [],
    'constraintguard.constraints.severity.must': 0,
    'constraintguard.constraints.severity.should': 0,
  });
  assert.equal(Object.keys(attrs).length, 4);
});

test('constraints: id order is preserved verbatim', () => {
  const set = [
    { id: 'zebra', text: 'z', severity: 'must' },
    { id: 'alpha', text: 'a', severity: 'should' },
    { id: 'mike', text: 'm', severity: 'must' },
  ];
  const attrs = constraintsToSpanAttributes(set);
  assert.deepEqual(attrs['constraintguard.constraints.ids'], ['zebra', 'alpha', 'mike']);
});

test('constraints: malformed input throws (delegated to validateConstraintSet)', () => {
  assert.throws(() => constraintsToSpanAttributes('not an array'), /must be an array/);
  assert.throws(() => constraintsToSpanAttributes([{ id: 'x', text: 'y' }]), /severity/);
});

test('constraints: text is never emitted (privacy)', () => {
  const set = [{ id: 'no-pii', text: 'a sensitive policy body', severity: 'must' }];
  const attrs = constraintsToSpanAttributes(set);
  assert.ok(!JSON.stringify(attrs).includes('sensitive policy body'));
});

test('conformance: a result with one drop maps to the five keys', () => {
  const result = {
    score: 0.75,
    total: 4,
    survived: 3,
    dropped: [{ id: 'no-pii', text: 'Never leak PII.', severity: 'must' }],
  };
  const attrs = conformanceToSpanAttributes(result);
  assert.deepEqual(attrs, {
    'constraintguard.conformance.score': 0.75,
    'constraintguard.conformance.total': 4,
    'constraintguard.conformance.survived': 3,
    'constraintguard.conformance.dropped.count': 1,
    'constraintguard.conformance.dropped.ids': ['no-pii'],
  });
});

test('conformance: score is the exact float, not rounded for display', () => {
  const result = { score: 2 / 3, total: 3, survived: 2, dropped: [{ id: 'x' }] };
  const attrs = conformanceToSpanAttributes(result);
  assert.equal(attrs['constraintguard.conformance.score'], 2 / 3);
});

test('conformance: total === 0 vacuous perfect score flows through', () => {
  const result = { score: 1, total: 0, survived: 0, dropped: [] };
  const attrs = conformanceToSpanAttributes(result);
  assert.deepEqual(attrs, {
    'constraintguard.conformance.score': 1,
    'constraintguard.conformance.total': 0,
    'constraintguard.conformance.survived': 0,
    'constraintguard.conformance.dropped.count': 0,
    'constraintguard.conformance.dropped.ids': [],
  });
});

test('conformance: dropped.ids follow dropped order, count === length', () => {
  const result = {
    score: 0,
    total: 3,
    survived: 0,
    dropped: [{ id: 'c' }, { id: 'a' }, { id: 'b' }],
  };
  const attrs = conformanceToSpanAttributes(result);
  assert.deepEqual(attrs['constraintguard.conformance.dropped.ids'], ['c', 'a', 'b']);
  assert.equal(attrs['constraintguard.conformance.dropped.count'], result.dropped.length);
});

test('every returned value is OTel-legal, for both mappers', () => {
  assertAllLegal(
    constraintsToSpanAttributes([{ id: 'a', text: 'x', severity: 'must' }]),
  );
  assertAllLegal(constraintsToSpanAttributes([]));
  assertAllLegal(
    conformanceToSpanAttributes({ score: 0.5, total: 2, survived: 1, dropped: [{ id: 'a' }] }),
  );
  assertAllLegal(conformanceToSpanAttributes({ score: 1, total: 0, survived: 0, dropped: [] }));
});

test('determinism: two calls on the same input are deep-equal', () => {
  const set = [{ id: 'a', text: 'x', severity: 'must' }];
  assert.deepEqual(constraintsToSpanAttributes(set), constraintsToSpanAttributes(set));
  const result = { score: 0.5, total: 2, survived: 1, dropped: [{ id: 'a' }] };
  assert.deepEqual(conformanceToSpanAttributes(result), conformanceToSpanAttributes(result));
});
