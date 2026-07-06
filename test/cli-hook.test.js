import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CG = fileURLToPath(new URL('../bin/cg.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/claude-code-session.jsonl', import.meta.url));

const FIXTURE_SET = [
  { id: 'no-pii', text: 'Never leak personal data.', severity: 'must' },
  { id: 'keep-replies-concise', text: 'Keep replies concise.', severity: 'should' },
  { id: 'audit-log', text: 'Always write an audit log entry.', severity: 'must' },
];

// Run the CLI with an isolated cache dir: os.tmpdir() honors TMPDIR on POSIX, so
// pointing it at a fresh dir keeps each test's per-session cache self-contained.
function run(args, { input, tmp } = {}) {
  const env = { ...process.env };
  if (tmp) env.TMPDIR = tmp;
  return spawnSync(process.execPath, [CG, ...args], { encoding: 'utf8', input, env });
}

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'cg-hook-'));
}

test('end-to-end: pre-compact then session-start(compact) re-injects the fixture constraints', () => {
  const tmp = freshTmp();
  const sessionId = 'e2e-session';

  const pre = run(['hook', 'pre-compact'], {
    tmp,
    input: JSON.stringify({ session_id: sessionId, transcript_path: FIXTURE, hook_event_name: 'PreCompact', trigger: 'manual' }),
  });
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '', 'pre-compact emits no stdout');

  const start = run(['hook', 'session-start'], {
    tmp,
    input: JSON.stringify({ session_id: sessionId, source: 'compact', hook_event_name: 'SessionStart' }),
  });
  assert.equal(start.status, 0, start.stderr);
  const parsed = JSON.parse(start.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.match(ctx, /```constraints/);

  // The injected block extracts back to the fixture's constraints (pin/extract inverse).
  const ctxFile = join(tmp, 'ctx.md');
  writeFileSync(ctxFile, ctx);
  const extract = run(['extract', ctxFile], { tmp });
  assert.equal(extract.status, 0, extract.stderr);
  assert.deepEqual(JSON.parse(extract.stdout), FIXTURE_SET);
});

test('CLI session-start with source=startup prints nothing and exits 0', () => {
  const tmp = freshTmp();
  const res = run(['hook', 'session-start'], {
    tmp,
    input: JSON.stringify({ session_id: 's', source: 'startup' }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('CLI pre-compact with an unreadable transcript_path still exits 0 with no stdout', () => {
  const tmp = freshTmp();
  const res = run(['hook', 'pre-compact'], {
    tmp,
    input: JSON.stringify({ session_id: 's', transcript_path: '/no/such/file.jsonl' }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});

test('cg hook with an unknown event exits non-zero with usage on stderr', () => {
  const res = run(['hook', 'bogus']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown event/);
  assert.match(res.stderr, /usage: cg/);
});

test('cg hook with no event exits non-zero requiring an event', () => {
  const res = run(['hook']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /an event is required/);
});
