import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../src/index.js';

test('package loads and reports a version', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
