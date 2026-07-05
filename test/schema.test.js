import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConstraintSet } from '../src/index.js';

const valid = [
  { id: 'no-secrets', text: 'Never print secrets', severity: 'must' },
  { id: 'prefer-tests', text: 'Prefer adding tests', severity: 'should' },
];

test('accepts a well-formed constraint set and returns it', () => {
  assert.equal(validateConstraintSet(valid), valid);
});

test('accepts an empty set', () => {
  const empty = [];
  assert.equal(validateConstraintSet(empty), empty);
});

test('rejects a non-array set', () => {
  assert.throws(() => validateConstraintSet({}), /must be an array/);
  assert.throws(() => validateConstraintSet(null), /must be an array/);
});

test('rejects a non-object constraint', () => {
  assert.throws(() => validateConstraintSet(['nope']), /index 0 must be an object/);
  assert.throws(() => validateConstraintSet([null]), /index 0 must be an object/);
  assert.throws(() => validateConstraintSet([[]]), /index 0 must be an object/);
});

test('rejects a missing field, naming it', () => {
  assert.throws(
    () => validateConstraintSet([{ text: 'x', severity: 'must' }]),
    /missing required field "id"/,
  );
  assert.throws(
    () => validateConstraintSet([{ id: 'a', severity: 'must' }]),
    /missing required field "text"/,
  );
  assert.throws(
    () => validateConstraintSet([{ id: 'a', text: 'x' }]),
    /missing required field "severity"/,
  );
});

test('rejects a wrong-type field, naming it', () => {
  assert.throws(
    () => validateConstraintSet([{ id: 1, text: 'x', severity: 'must' }]),
    /field "id" must be a string/,
  );
  assert.throws(
    () => validateConstraintSet([{ id: 'a', text: 5, severity: 'must' }]),
    /field "text" must be a string/,
  );
});

test('rejects an empty id', () => {
  assert.throws(
    () => validateConstraintSet([{ id: '', text: 'x', severity: 'must' }]),
    /field "id" must not be empty/,
  );
});

test('rejects an invalid severity, naming allowed values', () => {
  assert.throws(
    () => validateConstraintSet([{ id: 'a', text: 'x', severity: 'maybe' }]),
    /severity" must be one of "must" \| "should"/,
  );
});

test('rejects duplicate ids', () => {
  assert.throws(
    () =>
      validateConstraintSet([
        { id: 'dup', text: 'x', severity: 'must' },
        { id: 'dup', text: 'y', severity: 'should' },
      ]),
    /duplicate constraint id "dup"/,
  );
});
