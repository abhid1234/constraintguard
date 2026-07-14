import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateBudget,
  validateReadLog,
  budgetReport,
  estimateTokens,
  budgetToSpanAttributes,
} from '../src/index.js';

// --- validateBudget --------------------------------------------------------

test('validateBudget accepts an empty budget (no caps)', () => {
  assert.deepEqual(validateBudget({}), { valid: true, errors: [] });
});

test('validateBudget accepts all three caps as non-negative numbers', () => {
  const r = validateBudget({ max_tokens: 8000, max_files: 20, max_tokens_per_file: 2000 });
  assert.deepEqual(r, { valid: true, errors: [] });
});

test('validateBudget accepts zero caps and unknown keys (open format)', () => {
  assert.equal(validateBudget({ max_tokens: 0 }).valid, true);
  assert.equal(validateBudget({ max_tokens: 100, note: 'ci gate' }).valid, true);
});

test('validateBudget rejects a non-object, naming the shape', () => {
  assert.deepEqual(validateBudget(null), {
    valid: false,
    errors: ['budget must be an object, got null'],
  });
  assert.equal(validateBudget([]).valid, false);
  assert.match(validateBudget([]).errors[0], /must be an object/);
  assert.equal(validateBudget('nope').valid, false);
});

test('validateBudget rejects a non-number cap, naming the field', () => {
  const r = validateBudget({ max_tokens: '8000' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /"max_tokens" must be a finite number/);
});

test('validateBudget rejects a non-finite or negative cap', () => {
  assert.match(validateBudget({ max_files: Infinity }).errors[0], /must be a finite number/);
  assert.match(validateBudget({ max_files: NaN }).errors[0], /must be a finite number/);
  assert.match(validateBudget({ max_tokens: -1 }).errors[0], /must not be negative/);
});

test('validateBudget collects every problem, not just the first', () => {
  const r = validateBudget({ max_tokens: -1, max_files: 'x', max_tokens_per_file: NaN });
  assert.equal(r.valid, false);
  assert.equal(r.errors.length, 3);
});

// --- validateReadLog -------------------------------------------------------

const READS = [
  { path: 'src/a.js', tokens: 400, used: true },
  { path: 'src/b.js', tokens: 600, used: false },
  { path: 'README.md', tokens: 200 },
];

test('validateReadLog accepts a well-formed read-log', () => {
  assert.deepEqual(validateReadLog(READS), { valid: true, errors: [] });
});

test('validateReadLog accepts an empty read-log', () => {
  assert.deepEqual(validateReadLog([]), { valid: true, errors: [] });
});

test('validateReadLog rejects a non-array', () => {
  assert.deepEqual(validateReadLog({}), {
    valid: false,
    errors: ['read-log must be an array, got object'],
  });
  assert.equal(validateReadLog(null).valid, false);
});

test('validateReadLog rejects a non-object read', () => {
  const r = validateReadLog(['nope']);
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /index 0 must be an object/);
});

test('validateReadLog rejects a missing field, naming it', () => {
  assert.match(validateReadLog([{ tokens: 5 }]).errors[0], /missing required field "path"/);
  assert.match(validateReadLog([{ path: 'a' }]).errors[0], /missing required field "tokens"/);
});

test('validateReadLog rejects a wrong-type / empty path', () => {
  assert.match(validateReadLog([{ path: 5, tokens: 1 }]).errors[0], /"path" must be a string/);
  assert.match(validateReadLog([{ path: '', tokens: 1 }]).errors[0], /"path" must not be empty/);
});

test('validateReadLog rejects a non-finite or negative tokens', () => {
  assert.match(validateReadLog([{ path: 'a', tokens: 'x' }]).errors[0], /"tokens" must be a finite number/);
  assert.match(validateReadLog([{ path: 'a', tokens: Infinity }]).errors[0], /"tokens" must be a finite number/);
  assert.match(validateReadLog([{ path: 'a', tokens: -3 }]).errors[0], /"tokens" must not be negative/);
});

test('validateReadLog rejects a non-boolean used flag', () => {
  assert.match(validateReadLog([{ path: 'a', tokens: 1, used: 'yes' }]).errors[0], /"used" must be a boolean/);
});

test('validateReadLog collects every problem across reads', () => {
  const r = validateReadLog([{ path: '', tokens: -1 }, { tokens: 'x' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 3);
});

// --- budgetReport math -----------------------------------------------------

test('budgetReport totals tokens and files, surfaces the unused list', () => {
  const report = budgetReport(READS);
  assert.equal(report.total_tokens, 1200);
  assert.equal(report.file_count, 3);
  assert.deepEqual(report.unused, [{ path: 'src/b.js', tokens: 600 }]);
  assert.equal(report.unused_tokens, 600);
});

test('budgetReport utilization + waste_ratio === 1', () => {
  const report = budgetReport(READS);
  assert.equal(report.waste_ratio, 600 / 1200);
  assert.equal(report.utilization, 600 / 1200);
  assert.equal(report.utilization + report.waste_ratio, 1);
});

test('budgetReport treats a missing used flag as needed (never over-accuses)', () => {
  // README.md has no `used` flag → not counted as waste.
  const report = budgetReport([
    { path: 'a', tokens: 100 },
    { path: 'b', tokens: 100, used: false },
  ]);
  assert.equal(report.unused_tokens, 100);
  assert.equal(report.waste_ratio, 0.5);
});

test('budgetReport with no budget is never over budget', () => {
  const report = budgetReport(READS);
  assert.equal(report.over_budget, false);
  assert.deepEqual(report.overages, []);
});

test('budgetReport flags a blown max_tokens cap', () => {
  const report = budgetReport(READS, { max_tokens: 1000 });
  assert.equal(report.over_budget, true);
  assert.deepEqual(report.overages, [{ cap: 'max_tokens', limit: 1000, actual: 1200 }]);
});

test('budgetReport flags a blown max_files cap', () => {
  const report = budgetReport(READS, { max_files: 2 });
  assert.deepEqual(report.overages, [{ cap: 'max_files', limit: 2, actual: 3 }]);
});

test('budgetReport flags max_tokens_per_file against the worst single file', () => {
  const report = budgetReport(READS, { max_tokens_per_file: 500 });
  assert.deepEqual(report.overages, [{ cap: 'max_tokens_per_file', limit: 500, actual: 600 }]);
});

test('budgetReport reports every blown cap together, in cap order', () => {
  const report = budgetReport(READS, { max_tokens: 100, max_files: 1, max_tokens_per_file: 100 });
  assert.equal(report.over_budget, true);
  assert.deepEqual(report.overages.map((o) => o.cap), ['max_tokens', 'max_files', 'max_tokens_per_file']);
});

test('budgetReport stays within budget when caps are met exactly (boundary)', () => {
  const report = budgetReport(READS, { max_tokens: 1200, max_files: 3, max_tokens_per_file: 600 });
  assert.equal(report.over_budget, false);
  assert.deepEqual(report.overages, []);
});

test('budgetReport on an empty read-log: zeroed, utilization 1, waste 0', () => {
  const report = budgetReport([]);
  assert.deepEqual(report, {
    total_tokens: 0,
    file_count: 0,
    over_budget: false,
    overages: [],
    unused: [],
    unused_tokens: 0,
    utilization: 1,
    waste_ratio: 0,
  });
});

test('budgetReport with all-zero tokens does not divide by zero', () => {
  const report = budgetReport([{ path: 'a', tokens: 0, used: false }]);
  assert.equal(report.utilization, 1);
  assert.equal(report.waste_ratio, 0);
});

test('budgetReport with all reads unused reports full waste', () => {
  const report = budgetReport([
    { path: 'a', tokens: 300, used: false },
    { path: 'b', tokens: 700, used: false },
  ]);
  assert.equal(report.waste_ratio, 1);
  assert.equal(report.utilization, 0);
  assert.equal(report.unused_tokens, 1000);
});

test('budgetReport is deterministic: two calls deep-equal', () => {
  assert.deepEqual(budgetReport(READS, { max_tokens: 500 }), budgetReport(READS, { max_tokens: 500 }));
});

// --- estimateTokens --------------------------------------------------------

test('estimateTokens is ~chars/4, rounded up', () => {
  assert.equal(estimateTokens('12345678'), 2);
  assert.equal(estimateTokens('12345'), 2); // ceil(5/4)
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(42), 0); // non-string → 0
});

// --- budgetToSpanAttributes ------------------------------------------------

test('budgetToSpanAttributes maps a report to the constraintguard.budget.* namespace', () => {
  const report = budgetReport(READS, { max_tokens: 1000 });
  const attrs = budgetToSpanAttributes(report);
  assert.deepEqual(attrs, {
    'constraintguard.budget.total_tokens': 1200,
    'constraintguard.budget.file_count': 3,
    'constraintguard.budget.used_tokens': 600,
    'constraintguard.budget.unused_tokens': 600,
    'constraintguard.budget.utilization': 0.5,
    'constraintguard.budget.waste_ratio': 0.5,
    'constraintguard.budget.over_budget': true,
    'constraintguard.budget.unused.count': 1,
    'constraintguard.budget.unused.paths': ['src/b.js'],
    'constraintguard.budget.overages.caps': ['max_tokens'],
  });
});

test('budgetToSpanAttributes values are all OTel-legal', () => {
  const attrs = budgetToSpanAttributes(budgetReport([]));
  for (const [k, v] of Object.entries(attrs)) {
    const legal =
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (Array.isArray(v) && v.every((e) => typeof e === 'string'));
    assert.ok(legal, `value for ${k} is not OTel-legal: ${JSON.stringify(v)}`);
  }
});

// --- CLI: cg budget --------------------------------------------------------

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

test('cg budget prints a report and exits 0 when within budget', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', path]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1200 tokens across 3 file\(s\)/);
  assert.match(res.stdout, /600 wasted/);
  assert.match(res.stdout, /src\/b\.js/);
});

test('cg budget --json prints the exact report object', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', '--json', path]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.total_tokens, 1200);
  assert.equal(report.waste_ratio, 0.5);
  assert.deepEqual(report.unused, [{ path: 'src/b.js', tokens: 600 }]);
});

test('cg budget exits 2 (CI gate) when over the token cap', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', '--max-tokens', '1000', path]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /OVER BUDGET/);
  assert.match(res.stdout, /max_tokens: 1200 > 1000/);
});

test('cg budget exits 2 when over the file cap', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', '--max-files', '2', path]);
  assert.equal(res.status, 2);
  assert.match(res.stdout, /max_files: 3 > 2/);
});

test('cg budget stays at exit 0 when the cap is met', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', '--max-tokens', '1200', path]);
  assert.equal(res.status, 0, res.stderr);
});

test('cg budget reads the read-log from stdin with -', () => {
  const res = run(['budget', '--json', '-'], { input: JSON.stringify(READS) });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).total_tokens, 1200);
});

test('cg budget on a missing argument exits 1 with usage', () => {
  const res = run(['budget']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /expected one <read-log/);
});

test('cg budget on invalid JSON exits 1 with a clear message', () => {
  const path = fixture('bad.json', '{ not json');
  const res = run(['budget', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid JSON/);
});

test('cg budget on a malformed read-log exits 1 with a clear message', () => {
  const path = fixture('bad.json', JSON.stringify([{ path: 'a' }]));
  const res = run(['budget', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing required field "tokens"/);
});

test('cg budget on an unreadable file exits 1', () => {
  const res = run(['budget', '/no/such/reads.json']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot read/);
});

test('cg budget with a bad cap value exits 1', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', '--max-tokens', 'lots', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /non-negative number/);
});

test('cg budget with an unknown flag exits 1', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['budget', '--nope', path]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown option/);
});

test('cg budget -h prints usage and exits 0', () => {
  const res = run(['budget', '-h']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /cg budget/);
});

test('cg otel budget prints the budget attribute JSON, exits 0', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['otel', 'budget', '--max-tokens', '1000', path]);
  assert.equal(res.status, 0, res.stderr);
  const attrs = JSON.parse(res.stdout);
  assert.equal(attrs['constraintguard.budget.total_tokens'], 1200);
  assert.equal(attrs['constraintguard.budget.over_budget'], true);
  assert.deepEqual(attrs['constraintguard.budget.unused.paths'], ['src/b.js']);
});

test('cg otel budget is a pure printer: exit 0 even when over budget', () => {
  const path = fixture('reads.json', JSON.stringify(READS));
  const res = run(['otel', 'budget', '--max-tokens', '1', path]);
  assert.equal(res.status, 0, res.stderr);
});

test('cg usage lists the budget subcommands', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /cg budget/);
  assert.match(res.stdout, /cg otel budget/);
});
