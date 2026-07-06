import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  adaptHarness,
  extractFromHarness,
  HARNESSES,
  validateConstraintSet,
} from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-code-session.jsonl', import.meta.url));
const transcript = readFileSync(FIXTURE, 'utf8');

// A user record whose content is a plain string.
const userString = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
// A user record whose content is an array of blocks.
const userBlocks = (blocks) => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } });

test('happy path: fixture yields exactly the user-declared constraints, in order', () => {
  const set = extractFromHarness('claude-code', transcript);
  assert.deepEqual(set, [
    { id: 'no-pii', text: 'Never leak personal data.', severity: 'must' },
    { id: 'keep-replies-concise', text: 'Keep replies concise.', severity: 'should' },
    { id: 'audit-log', text: 'Always write an audit log entry.', severity: 'must' },
  ]);
  assert.equal(validateConstraintSet(set), set);
});

test('decoy fences in assistant, thinking, and tool_result blocks are excluded', () => {
  const set = extractFromHarness('claude-code', transcript);
  const ids = set.map((c) => c.id);
  assert.ok(!ids.some((id) => id.startsWith('decoy')), `decoys leaked: ${ids.join(', ')}`);
});

test('string and array user content both contribute their text', () => {
  const raw = [
    userString('```constraints\nmust [a]: From a string.\n```'),
    userBlocks([{ type: 'text', text: '```constraints\nshould [b]: From a block.\n```' }]),
  ].join('\n');
  const set = extractFromHarness('claude-code', raw);
  assert.deepEqual(
    set.map((c) => c.id),
    ['a', 'b'],
  );
});

test('constraints split across two user turns are both extracted, in order', () => {
  const raw = [
    userString('```constraints\nmust [first]: One.\n```'),
    userString('```constraints\nmust [second]: Two.\n```'),
  ].join('\n');
  const set = extractFromHarness('claude-code', raw);
  assert.deepEqual(
    set.map((c) => c.id),
    ['first', 'second'],
  );
});

test('a fence only in an assistant text block is not extracted', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '```constraints\nmust [x]: nope.\n```' }] },
  });
  assert.deepEqual(extractFromHarness('claude-code', raw), []);
});

test('malformed and blank transcript lines are skipped with a warning, no throw', () => {
  const warnings = [];
  const raw = [
    'this is not json',
    '',
    userString('```constraints\nmust [ok]: survives.\n```'),
    '{ "type": "user", truncated…',
  ].join('\n');
  // Never throws, even under strict — strict is scoped to constraint lines, not
  // transcript parsing.
  const set = adaptHarness('claude-code', raw, { onWarning: (m) => warnings.push(m), strict: true });
  assert.match(set, /survives\./);
  assert.ok(warnings.some((w) => /not valid JSON/.test(w)), 'expected a JSON-parse warning');
});

test('a transcript with no constraints fence yields an empty set', () => {
  const raw = userString('just chatting, no rules here');
  assert.deepEqual(extractFromHarness('claude-code', raw), []);
});

test('determinism: same transcript yields an identical isolated context', () => {
  assert.equal(adaptHarness('claude-code', transcript), adaptHarness('claude-code', transcript));
});

test('a non-empty non-transcript file warns that no records were found', () => {
  const warnings = [];
  const out = adaptHarness('claude-code', 'plain markdown, not jsonl', { onWarning: (m) => warnings.push(m) });
  assert.equal(out, '');
  assert.ok(warnings.some((w) => /no valid Claude Code transcript records/.test(w)));
});

test('text harness is the identity adapter (returns raw verbatim)', () => {
  const raw = '```constraints\nmust: unchanged.\n```';
  assert.equal(adaptHarness('text', raw), raw);
});

test('unknown harness throws an Error naming the supported harnesses', () => {
  assert.throws(() => adaptHarness('nope', 'x'), (err) => {
    assert.match(err.message, /unknown harness/);
    for (const name of HARNESSES) assert.match(err.message, new RegExp(name));
    return true;
  });
});
