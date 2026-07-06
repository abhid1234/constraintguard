import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPreCompact, runSessionStart, parsePayload, unionById, INSTRUCTION } from '../src/hook.js';
import { extractFromHarness } from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-code-session.jsonl', import.meta.url));
const transcript = readFileSync(FIXTURE, 'utf8');

const FIXTURE_SET = [
  { id: 'no-pii', text: 'Never leak personal data.', severity: 'must' },
  { id: 'keep-replies-concise', text: 'Keep replies concise.', severity: 'should' },
  { id: 'audit-log', text: 'Always write an audit log entry.', severity: 'must' },
];

// A fake cache backed by a Map, plus a fake readFileSync that serves canned
// transcripts by path. Mirrors the `deps` shape the CLI wires with real fs.
function fakeDeps({ files = {}, cache = {} } = {}) {
  const store = new Map(Object.entries(cache));
  return {
    store,
    readFileSync: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    readCache: (id) => store.get(id) ?? [],
    writeCache: (id, set) => store.set(id, set),
  };
}

test('pre-compact caches the extracted set, empty stdout, exit 0', () => {
  const deps = fakeDeps({ files: { '/t.jsonl': transcript } });
  const res = runPreCompact(
    JSON.stringify({ session_id: 's1', transcript_path: '/t.jsonl', hook_event_name: 'PreCompact', trigger: 'manual' }),
    deps,
  );
  assert.deepEqual(res, { exitCode: 0, stdout: '' });
  assert.deepEqual(deps.store.get('s1'), FIXTURE_SET);
});

test('union across two compactions: A ∪ B, deduped by id, A wins on collision', () => {
  const setA = [{ id: 'shared', text: 'from A.', severity: 'must' }, { id: 'a-only', text: 'A only.', severity: 'should' }];
  const bTranscript =
    '{"type":"user","message":{"role":"user","content":"```constraints\\nshould [shared]: from B.\\nmust [b-only]: B only.\\n```"}}';
  const deps = fakeDeps({ files: { '/b.jsonl': bTranscript }, cache: { s1: setA } });
  runPreCompact(JSON.stringify({ session_id: 's1', transcript_path: '/b.jsonl' }), deps);

  const merged = deps.store.get('s1');
  assert.deepEqual(merged.map((c) => c.id), ['shared', 'a-only', 'b-only']);
  // A's text/severity win on the id collision.
  assert.deepEqual(merged.find((c) => c.id === 'shared'), { id: 'shared', text: 'from A.', severity: 'must' });
});

test('session-start(compact) emits the expected hookSpecificOutput shape with a constraints block', () => {
  const deps = fakeDeps({ cache: { s1: FIXTURE_SET } });
  const res = runSessionStart(JSON.stringify({ session_id: 's1', source: 'compact' }), deps);
  assert.equal(res.exitCode, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith(INSTRUCTION), 'additionalContext should start with the instruction line');
  assert.match(ctx, /```constraints/);
});

test('round-trip: the injected additionalContext extracts back to the cached set', () => {
  const deps = fakeDeps({ cache: { s1: FIXTURE_SET } });
  const res = runSessionStart(JSON.stringify({ session_id: 's1', source: 'compact' }), deps);
  const ctx = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
  const roundTripped = extractFromHarness('text', ctx);
  assert.deepEqual(roundTripped, FIXTURE_SET);
});

test('session-start is silent for non-compact source, missing cache, and empty set', () => {
  const deps = fakeDeps({ cache: { s1: FIXTURE_SET, empty: [] } });
  // Wrong source.
  assert.deepEqual(runSessionStart(JSON.stringify({ session_id: 's1', source: 'startup' }), deps), { exitCode: 0, stdout: '' });
  // No cache for this session.
  assert.deepEqual(runSessionStart(JSON.stringify({ session_id: 'nope', source: 'compact' }), deps), { exitCode: 0, stdout: '' });
  // Empty cached set.
  assert.deepEqual(runSessionStart(JSON.stringify({ session_id: 'empty', source: 'compact' }), deps), { exitCode: 0, stdout: '' });
});

test('failure paths always exit 0 with empty stdout, never throw', () => {
  // Bad stdin JSON.
  assert.equal(runPreCompact('{', fakeDeps()).exitCode, 0);
  assert.equal(runSessionStart('{', fakeDeps()).exitCode, 0);

  // readFileSync throws (unreadable transcript_path).
  const throwsRead = { ...fakeDeps(), readFileSync: () => { throw new Error('EACCES'); } };
  const r1 = runPreCompact(JSON.stringify({ session_id: 's', transcript_path: '/x' }), throwsRead);
  assert.deepEqual({ exitCode: r1.exitCode, stdout: r1.stdout }, { exitCode: 0, stdout: '' });

  // writeCache throws (un-writable cache dir).
  const throwsWrite = {
    ...fakeDeps({ files: { '/t.jsonl': transcript } }),
    writeCache: () => { throw new Error('EROFS'); },
  };
  const r2 = runPreCompact(JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl' }), throwsWrite);
  assert.deepEqual({ exitCode: r2.exitCode, stdout: r2.stdout }, { exitCode: 0, stdout: '' });
});

test('no-constraints transcript caches [] and a following session-start is silent', () => {
  const deps = fakeDeps({ files: { '/plain.jsonl': '{"type":"user","message":{"role":"user","content":"just chatting"}}' } });
  runPreCompact(JSON.stringify({ session_id: 's1', transcript_path: '/plain.jsonl' }), deps);
  assert.deepEqual(deps.store.get('s1'), []);
  assert.deepEqual(runSessionStart(JSON.stringify({ session_id: 's1', source: 'compact' }), deps), { exitCode: 0, stdout: '' });
});

test('pre-compact with a missing session_id or transcript_path is a silent no-op', () => {
  const deps = fakeDeps({ files: { '/t.jsonl': transcript } });
  assert.deepEqual(runPreCompact(JSON.stringify({ transcript_path: '/t.jsonl' }), deps), { exitCode: 0, stdout: '' });
  assert.deepEqual(runPreCompact(JSON.stringify({ session_id: 's1' }), deps), { exitCode: 0, stdout: '' });
  assert.equal(deps.store.size, 0);
});

test('parsePayload tolerates junk and non-object JSON, returning {}', () => {
  assert.deepEqual(parsePayload('{'), {});
  assert.deepEqual(parsePayload('[1,2]'), {});
  assert.deepEqual(parsePayload('null'), {});
  assert.deepEqual(parsePayload(''), {});
  assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
});

test('unionById drops malformed entries and preserves first-seen order', () => {
  const merged = unionById(
    [{ id: 'a', text: 'A.', severity: 'must' }, null, { text: 'no id', severity: 'must' }],
    [{ id: 'a', text: 'dup.', severity: 'should' }, { id: 'b', text: 'B.', severity: 'should' }],
  );
  assert.deepEqual(merged, [
    { id: 'a', text: 'A.', severity: 'must' },
    { id: 'b', text: 'B.', severity: 'should' },
  ]);
});
