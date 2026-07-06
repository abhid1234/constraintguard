import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CG = fileURLToPath(new URL('../bin/cg.js', import.meta.url));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CG, ...args], { encoding: 'utf8', ...opts });
}

function fixture(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-test-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const block = (lines) => '```constraints\n' + lines.join('\n') + '\n```';

test('cg otel constraints prints the constraints attribute JSON, exits 0', () => {
  const path = fixture(
    'session.md',
    block(['must [no-pii]: Never leak PII.', 'should [terse]: Keep it short.']),
  );
  const res = run(['otel', 'constraints', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    'constraintguard.constraints.count': 2,
    'constraintguard.constraints.ids': ['no-pii', 'terse'],
    'constraintguard.constraints.severity.must': 1,
    'constraintguard.constraints.severity.should': 1,
  });
});

test('cg otel constraints on a context with no block prints the zeroed object', () => {
  const path = fixture('empty.md', 'no constraints here');
  const res = run(['otel', 'constraints', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    'constraintguard.constraints.count': 0,
    'constraintguard.constraints.ids': [],
    'constraintguard.constraints.severity.must': 0,
    'constraintguard.constraints.severity.should': 0,
  });
});

test('cg otel conformance prints the conformance attribute JSON, exits 0', () => {
  const original = fixture(
    'original.md',
    block([
      'must [no-pii]: Never leak PII.',
      'must [cite]: Cite your sources.',
      'should [terse]: Keep it short.',
      'must [safe]: Refuse unsafe requests.',
    ]),
  );
  const compacted = fixture(
    'compacted.md',
    block([
      'must [cite]: Cite your sources.',
      'should [terse]: Keep it short.',
      'must [safe]: Refuse unsafe requests.',
    ]),
  );
  const res = run(['otel', 'conformance', original, compacted]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    'constraintguard.conformance.score': 0.75,
    'constraintguard.conformance.total': 4,
    'constraintguard.conformance.survived': 3,
    'constraintguard.conformance.dropped.count': 1,
    'constraintguard.conformance.dropped.ids': ['no-pii'],
  });
});

test('cg otel with no mode exits 1 with a clear message', () => {
  const res = run(['otel']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /a mode is required/);
});

test('cg otel with an unknown mode exits 1 with a clear message', () => {
  const res = run(['otel', 'bogus']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown mode/);
});

test('cg otel constraints with the wrong positional count exits 1', () => {
  const res = run(['otel', 'constraints']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /expected one context file/);
});

test('cg otel constraints with an unknown flag exits 1', () => {
  const path = fixture('session.md', block(['must: x']));
  const res = run(['otel', 'constraints', '--nope', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown option/);
});

test('cg otel constraints on an unreadable file exits 1', () => {
  const res = run(['otel', 'constraints', '/no/such/file/here.md']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read/);
});

test('cg otel -h prints usage and exits 0', () => {
  const res = run(['otel', '-h']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /cg otel constraints/);
});
