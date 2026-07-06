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

const FIXTURE = fileURLToPath(new URL('./fixtures/codex-session.jsonl', import.meta.url));
const rollout = readFileSync(FIXTURE, 'utf8');

// A response_item user message whose content is an array of input_text blocks.
const userMsg = (text) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
// A response_item user message whose content is a plain string (defensive path).
const userStringMsg = (text) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: text } });
// The event_msg user_message UI echo (must never be scanned).
const eventEcho = (message) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } });

test('happy path: fixture yields exactly the user-declared constraints, in order', () => {
  const set = extractFromHarness('codex', rollout);
  assert.deepEqual(set, [
    { id: 'no-pii', text: 'Never leak personal data.', severity: 'must' },
    { id: 'keep-replies-concise', text: 'Keep replies concise.', severity: 'should' },
    { id: 'audit-log', text: 'Always write an audit log entry.', severity: 'must' },
  ]);
  assert.equal(validateConstraintSet(set), set);
});

test('decoy fences in assistant, reasoning, tool-output, and event_msg records are excluded', () => {
  const set = extractFromHarness('codex', rollout);
  const ids = set.map((c) => c.id);
  assert.ok(!ids.some((id) => id.startsWith('decoy')), `decoys leaked: ${ids.join(', ')}`);
  // The fixture's event_msg record carries a UNIQUE id, so this proves the
  // exclusion directly — dedup against a user turn can't mask a regression.
  assert.ok(!ids.includes('decoy-event'), 'event_msg fence leaked');
});

test('no double-count: an event_msg echo of a user turn is not scanned', () => {
  // The event_msg fence carries a UNIQUE id absent from every user turn, so if a
  // regression started scanning event_msg it would appear here — dedup can't hide it.
  const raw = [
    userMsg('```constraints\nmust [only-once]: Declared exactly once.\n```'),
    eventEcho('```constraints\nmust [decoy-event]: Event-msg fence must be ignored.\n```'),
  ].join('\n');
  const set = extractFromHarness('codex', raw);
  assert.deepEqual(
    set.map((c) => c.id),
    ['only-once'],
  );
});

test('string and array user content both contribute their text', () => {
  const raw = [
    userStringMsg('```constraints\nmust [a]: From a string.\n```'),
    userMsg('```constraints\nshould [b]: From a block.\n```'),
  ].join('\n');
  const set = extractFromHarness('codex', raw);
  assert.deepEqual(
    set.map((c) => c.id),
    ['a', 'b'],
  );
});

test('constraints split across two user turns are both extracted, in order', () => {
  const raw = [
    userMsg('```constraints\nmust [first]: One.\n```'),
    userMsg('```constraints\nmust [second]: Two.\n```'),
  ].join('\n');
  const set = extractFromHarness('codex', raw);
  assert.deepEqual(
    set.map((c) => c.id),
    ['first', 'second'],
  );
});

test('a fence only in an assistant message is not extracted', () => {
  const raw = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '```constraints\nmust [x]: nope.\n```' }] },
  });
  assert.deepEqual(extractFromHarness('codex', raw), []);
});

test('malformed and blank rollout lines are skipped with a warning, no throw', () => {
  const warnings = [];
  const raw = [
    'this is not json',
    '',
    userMsg('```constraints\nmust [ok]: survives.\n```'),
    '{ "type": "response_item", truncated…',
  ].join('\n');
  // Never throws, even under strict — strict is scoped to constraint lines, not
  // rollout parsing.
  const set = adaptHarness('codex', raw, { onWarning: (m) => warnings.push(m), strict: true });
  assert.match(set, /survives\./);
  assert.ok(warnings.some((w) => /not valid JSON/.test(w)), 'expected a JSON-parse warning');
});

test('a rollout with no constraints fence yields an empty set', () => {
  const raw = userMsg('just chatting, no rules here');
  assert.deepEqual(extractFromHarness('codex', raw), []);
});

test('determinism: same rollout yields an identical isolated context', () => {
  assert.equal(adaptHarness('codex', rollout), adaptHarness('codex', rollout));
});

test('a non-empty non-rollout file warns that no records were found', () => {
  const warnings = [];
  const out = adaptHarness('codex', 'plain markdown, not jsonl', { onWarning: (m) => warnings.push(m) });
  assert.equal(out, '');
  assert.ok(warnings.some((w) => /no valid Codex rollout records/.test(w)));
});

test('unknown harness throws an Error naming the supported harnesses (incl. codex)', () => {
  assert.ok(HARNESSES.includes('codex'));
  assert.throws(() => adaptHarness('nope', 'x'), (err) => {
    assert.match(err.message, /unknown harness/);
    for (const name of HARNESSES) assert.match(err.message, new RegExp(name));
    return true;
  });
});
