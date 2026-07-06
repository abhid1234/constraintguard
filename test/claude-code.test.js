import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeCodeToContext, extractConstraints } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-code-session.jsonl', import.meta.url));

test('adapts a real transcript into constraint-bearing text and extracts the declared set', () => {
  const jsonl = readFileSync(FIXTURE, 'utf8');
  const set = extractConstraints(claudeCodeToContext(jsonl));
  // Only operator/system-authored constraints survive, in transcript order.
  assert.deepEqual(set, [
    { id: 'no-secrets', text: 'Never commit secrets to the repository.', severity: 'must' },
    { id: 'prefer-the-smallest-cohesive-change', text: 'Prefer the smallest cohesive change.', severity: 'should' },
    { id: 'no-force-push', text: 'Never force-push to the main branch.', severity: 'must' },
  ]);
  // The assistant-authored and tool_result (file-read) fences are excluded.
  assert.equal(set.some((c) => c.id === 'assistant-decoy' || c.id === 'file-decoy'), false);
});

test('reads string and text-block content; skips assistant, tool, thinking, and bookkeeping records', () => {
  const ctx = claudeCodeToContext(readFileSync(FIXTURE, 'utf8'));
  assert.match(ctx, /no-secrets/);
  assert.match(ctx, /no-force-push/);
  assert.doesNotMatch(ctx, /assistant-decoy/); // assistant role dropped
  assert.doesNotMatch(ctx, /file-decoy/); // tool_result block dropped
  assert.doesNotMatch(ctx, /wants me to follow/); // thinking block dropped
});

test('plain-string message content is read directly', () => {
  const jsonl = JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain rule text' } });
  assert.equal(claudeCodeToContext(jsonl), 'plain rule text');
});

test('malformed JSON lines are skipped with a warning; valid records survive', () => {
  const warnings = [];
  const jsonl = [
    '{ not valid json',
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }),
    '',
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }),
  ].join('\n');
  const ctx = claudeCodeToContext(jsonl, { onWarning: (m) => warnings.push(m) });
  assert.equal(ctx, 'first\n\nsecond');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line 1:.*not valid JSON/);
});

test('strict mode throws on the first malformed JSON line', () => {
  const jsonl = '{ not valid json\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } });
  assert.throws(() => claudeCodeToContext(jsonl, { strict: true }), /line 1:.*not valid JSON/);
});

test('records without a readable message contribute nothing', () => {
  const jsonl = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
    JSON.stringify({ type: 'summary', summary: 'a title' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'model output' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_use', input: {} }] } }),
  ].join('\n');
  assert.equal(claudeCodeToContext(jsonl), '');
});

test('empty input yields an empty context', () => {
  assert.equal(claudeCodeToContext(''), '');
  assert.equal(claudeCodeToContext('\n\n'), '');
});

test('non-string input throws', () => {
  assert.throws(() => claudeCodeToContext(null), /expects a string/);
  assert.throws(() => claudeCodeToContext(42), /expects a string/);
});
