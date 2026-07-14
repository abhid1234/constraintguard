#!/usr/bin/env node
// ConstraintGuard CLI. Subcommands are added issue-by-issue; today: `extract`,
// `conformance`, `pin`, `otel`, `budget`. Future subcommands (`validate`) slot in
// as sibling cases in main(). Zero dependencies: Node standard library only.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractConstraints,
  scoreConformance,
  pinConstraints,
  budgetReport,
  validateReadLog,
  constraintsToSpanAttributes,
  conformanceToSpanAttributes,
  budgetToSpanAttributes,
  adaptHarness,
  HARNESSES,
} from '../src/index.js';
import { runPreCompact, runSessionStart, safeSessionKey } from '../src/hook.js';

const USAGE = [
  'usage: cg extract [--strict] [--harness text|claude-code|codex|cursor|antigravity] <context-file-or-project-dir>',
  '       cg conformance [--json] [--match id|exact] [--threshold <t>] [--strict] <original> <compacted>',
  '       cg pin <constraints-json|-> <context-file>',
  '       cg budget [--json] [--max-tokens N] [--max-files N] [--max-tokens-per-file N] <read-log-json|->',
  '       cg otel constraints [--strict] <context-file>',
  '       cg otel conformance [--match id|exact] [--strict] <original> <compacted>',
  '       cg otel budget [--max-tokens N] [--max-files N] [--max-tokens-per-file N] <read-log-json|->',
  '       cg hook pre-compact    # PreCompact: cache declared constraints (stdin: hook JSON)',
  '       cg hook session-start  # SessionStart(compact): re-inject cached constraints',
].join('\n');

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'extract':
      return cmdExtract(rest);
    case 'conformance':
      return cmdConformance(rest);
    case 'pin':
      return cmdPin(rest);
    case 'budget':
      return cmdBudget(rest);
    case 'otel':
      return cmdOtel(rest);
    case 'hook':
      return cmdHook(rest);
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE + '\n');
      return;
    default:
      fail(`unknown command ${JSON.stringify(cmd)}\n${USAGE}`);
  }
}

function cmdExtract(args) {
  let strict = false;
  let harness = 'text';
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict') strict = true;
    else if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a === '--harness') {
      harness = args[++i];
      if (harness === undefined || (harness.startsWith('-') && harness !== '-')) {
        fail(`extract: --harness requires a value (one of: ${HARNESSES.join(', ')})\n${USAGE}`);
      }
    } else if (a.startsWith('-') && a !== '-') fail(`extract: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length === 0) fail(`extract: a context file is required\n${USAGE}`);
  if (files.length > 1) fail(`extract: expected one context file, got ${files.length}\n${USAGE}`);

  const file = files[0];
  const onWarning = (msg) => process.stderr.write(`warning: ${msg}\n`);

  // Resolve the raw context, then hand it to the shared `extractConstraints`
  // path below. `cursor` accepts a project directory (discovering its rule
  // sources) as well as a single rule file, so it owns its own reading; every
  // other harness reads the one named file and runs it through its adapter
  // (`text`, the default, is the identity adapter — a no-op).
  let context;
  if (harness === 'cursor') {
    context = readCursorContext(file, onWarning);
  } else {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      fail(`extract: cannot read ${file}: ${err.message}`);
    }
    try {
      context = adaptHarness(harness, text, { onWarning });
    } catch (err) {
      fail(`extract: ${err.message}`);
    }
  }

  let set;
  try {
    set = extractConstraints(context, { strict, onWarning });
  } catch (err) {
    fail(`extract: ${err.message}`);
  }

  if (set.length === 0) process.stderr.write('note: no constraints found\n');
  process.stdout.write(JSON.stringify(set, null, 2) + '\n');
}

// Resolve the isolated context for `--harness cursor`. `path` is either a single
// rule file (read + adapted directly) or a project root, in which case we
// discover its rule sources — `<root>/.cursorrules` and every
// `<root>/.cursor/rules/*.mdc`, in deterministic sorted order — adapt each
// through the pure `cursor` adapter, and join them. Discovery is the only
// filesystem work the cursor adapter needs, so it lives here (the CLI owns I/O),
// keeping the library adapter pure. A *missing* `.cursorrules` / rules dir is
// normal (not an error); a *present-but-unreadable* one fails clearly.
function readCursorContext(path, onWarning) {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    fail(`extract: cannot read ${path}: ${err.message}`);
  }

  if (!stat.isDirectory()) {
    // A single rule file: adapt it directly (`.mdc` → strip frontmatter). The
    // extension gates stripping, so a `.cursorrules` starting with a `---`
    // markdown rule is never mistaken for frontmatter.
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      fail(`extract: cannot read ${path}: ${err.message}`);
    }
    return adaptHarness('cursor', raw, { mdc: path.endsWith('.mdc'), onWarning });
  }

  const parts = [];
  let found = 0;

  // 1. Legacy plaintext `.cursorrules` at the project root (if present).
  const rulesFile = join(path, '.cursorrules');
  try {
    const raw = readFileSync(rulesFile, 'utf8');
    found++;
    const ctx = adaptHarness('cursor', raw, { mdc: false, onWarning });
    if (ctx) parts.push(ctx);
  } catch (err) {
    if (err.code !== 'ENOENT') fail(`extract: cannot read ${rulesFile}: ${err.message}`);
  }

  // 2. Every `<root>/.cursor/rules/*.mdc`, sorted for a deterministic union.
  const rulesDir = join(path, '.cursor', 'rules');
  let entries = null;
  try {
    entries = readdirSync(rulesDir);
  } catch (err) {
    if (err.code !== 'ENOENT') fail(`extract: cannot read ${rulesDir}: ${err.message}`);
  }
  if (entries) {
    for (const name of entries.filter((n) => n.endsWith('.mdc')).sort()) {
      const mdcFile = join(rulesDir, name);
      let raw;
      try {
        raw = readFileSync(mdcFile, 'utf8');
      } catch (err) {
        fail(`extract: cannot read ${mdcFile}: ${err.message}`);
      }
      found++;
      const ctx = adaptHarness('cursor', raw, { mdc: true, onWarning });
      if (ctx) parts.push(ctx);
    }
  }

  if (found === 0) {
    onWarning(`no Cursor rule sources found under ${path} (looked for .cursorrules and .cursor/rules/*.mdc)`);
    return '';
  }
  // Blank line between sources so a fence never welds onto adjacent text and
  // each stays independently detectable by #2's line scanner.
  return parts.join('\n\n');
}

function cmdPin(args) {
  const files = [];
  for (const a of args) {
    if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a.startsWith('-') && a !== '-') fail(`pin: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length < 2) fail(`pin: a constraints source and a context file are required\n${USAGE}`);
  if (files.length > 2) fail(`pin: expected <constraints-json|-> <context-file>, got ${files.length} arguments\n${USAGE}`);

  const [source, ctxFile] = files;

  let raw;
  try {
    // `-` reads the constraint set from stdin (fd 0), so it pipes from `extract`:
    //   cg extract old.md | cg pin - compacted.md
    raw = readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch (err) {
    fail(`pin: cannot read ${source === '-' ? 'stdin' : source}: ${err.message}`);
  }

  let set;
  try {
    set = JSON.parse(raw);
  } catch (err) {
    fail(`pin: invalid JSON constraint set: ${err.message}`);
  }

  let ctx;
  try {
    ctx = readFileSync(ctxFile, 'utf8');
  } catch (err) {
    fail(`pin: cannot read ${ctxFile}: ${err.message}`);
  }

  let out;
  try {
    out = pinConstraints(set, ctx);
  } catch (err) {
    fail(`pin: ${err.message}`);
  }

  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
}

function cmdConformance(args) {
  let json = false;
  let strict = false;
  let match = 'exact';
  let threshold; // undefined until --threshold is given
  const files = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--strict') strict = true;
    else if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a === '--match') {
      match = args[++i];
      if (match !== 'id' && match !== 'exact') {
        fail(`conformance: --match must be "id" or "exact", got ${JSON.stringify(match)}\n${USAGE}`);
      }
    } else if (a === '--threshold') {
      threshold = Number(args[++i]);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        fail(`conformance: --threshold must be a number in [0, 1], got ${JSON.stringify(args[i])}\n${USAGE}`);
      }
    } else if (a.startsWith('-') && a !== '-') {
      fail(`conformance: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    } else files.push(a);
  }

  if (files.length !== 2) {
    fail(`conformance: expected <original> <compacted>, got ${files.length} file argument(s)\n${USAGE}`);
  }

  const [originalPath, compactedPath] = files;
  const original = readContext('conformance', originalPath);
  const compacted = readContext('conformance', compactedPath);

  let result;
  try {
    result = scoreConformance(original, compacted, {
      match,
      strict,
      onWarning: (msg, source) => {
        const label = source === 'compacted' ? compactedPath : originalPath;
        process.stderr.write(`warning: ${label}: ${msg}\n`);
      },
    });
  } catch (err) {
    fail(`conformance: ${err.message}`);
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatConformance(result) + '\n');
  }

  // --threshold turns the command into a CI gate; exit 2 (distinct from the
  // exit-1 error path) when the score falls below the gate.
  if (threshold !== undefined && result.score < threshold) process.exit(2);
}

// `cg budget [caps] <read-log-json|->` — audit what an agent loaded into context
// against an optional token/file budget, surfacing loaded-but-unused waste. Caps
// come from flags (`--max-tokens`, `--max-files`, `--max-tokens-per-file`); the
// read-log is a JSON array of `{ path, tokens, used? }` reads (or `-` for stdin).
// Prints a human report (or `--json`) and, like `conformance --threshold`, turns
// into a CI gate: exit 2 (distinct from the exit-1 error path) when over budget.
function cmdBudget(args) {
  let json = false;
  const budget = {};
  const files = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a === '--max-tokens') budget.max_tokens = parseCap('budget', a, args[++i]);
    else if (a === '--max-files') budget.max_files = parseCap('budget', a, args[++i]);
    else if (a === '--max-tokens-per-file') budget.max_tokens_per_file = parseCap('budget', a, args[++i]);
    else if (a.startsWith('-') && a !== '-') fail(`budget: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }

  if (files.length !== 1) {
    fail(`budget: expected one <read-log-json|->, got ${files.length} argument(s)\n${USAGE}`);
  }

  const reads = readReadLog('budget', files[0]);
  const hasCap = Object.keys(budget).length > 0;
  const report = budgetReport(reads, hasCap ? budget : undefined);

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatBudget(report) + '\n');
  }

  if (report.over_budget) process.exit(2);
}

// Parse a `--max-*` cap flag value into a finite non-negative number, failing
// (exit 1) with a clear message otherwise. Shared by `budget` and `otel budget`.
function parseCap(cmd, flag, raw) {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n < 0) {
    fail(`${cmd}: ${flag} requires a non-negative number, got ${JSON.stringify(raw)}\n${USAGE}`);
  }
  return n;
}

// Read + parse a read-log (JSON array of reads) from a file or `-` (stdin), then
// validate its shape via `validateReadLog`. Fails (exit 1) with a clear message
// on an unreadable source, invalid JSON, or a malformed read-log. Shared by
// `budget` and `otel budget`.
function readReadLog(cmd, source) {
  let raw;
  try {
    raw = readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch (err) {
    fail(`${cmd}: cannot read ${source === '-' ? 'stdin' : source}: ${err.message}`);
  }

  let reads;
  try {
    reads = JSON.parse(raw);
  } catch (err) {
    fail(`${cmd}: invalid JSON read-log: ${err.message}`);
  }

  const { valid, errors } = validateReadLog(reads);
  if (!valid) fail(`${cmd}: ${errors[0]}`);
  return reads;
}

// `cg otel <mode> …` — print ConstraintGuard data as OpenTelemetry span
// attributes (JSON). Two modes mirror the two library mappers and reuse the
// extract / conformance plumbing; `otel` is a pure printer, so it always exits
// 0 on success (no `--threshold`/exit-2 gate).
function cmdOtel(args) {
  const [mode, ...rest] = args;
  switch (mode) {
    case 'constraints':
      return cmdOtelConstraints(rest);
    case 'conformance':
      return cmdOtelConformance(rest);
    case 'budget':
      return cmdOtelBudget(rest);
    case '-h':
    case '--help':
      return void process.stdout.write(USAGE + '\n');
    case undefined:
      return fail(`otel: a mode is required (constraints | conformance | budget)\n${USAGE}`);
    default:
      return fail(`otel: unknown mode ${JSON.stringify(mode)} (expected constraints | conformance | budget)\n${USAGE}`);
  }
}

function cmdOtelConstraints(args) {
  let strict = false;
  const files = [];
  for (const a of args) {
    if (a === '--strict') strict = true;
    else if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a.startsWith('-') && a !== '-') fail(`otel: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length !== 1) {
    fail(`otel constraints: expected one context file, got ${files.length}\n${USAGE}`);
  }

  const text = readContext('otel', files[0]);
  let attrs;
  try {
    const set = extractConstraints(text, {
      strict,
      onWarning: (msg) => process.stderr.write(`warning: ${msg}\n`),
    });
    attrs = constraintsToSpanAttributes(set);
  } catch (err) {
    fail(`otel: ${err.message}`);
  }
  process.stdout.write(JSON.stringify(attrs, null, 2) + '\n');
}

function cmdOtelConformance(args) {
  let strict = false;
  let match = 'exact';
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--strict') strict = true;
    else if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a === '--match') {
      match = args[++i];
      if (match !== 'id' && match !== 'exact') {
        fail(`otel: --match must be "id" or "exact", got ${JSON.stringify(match)}\n${USAGE}`);
      }
    } else if (a.startsWith('-') && a !== '-') {
      fail(`otel: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    } else files.push(a);
  }
  if (files.length !== 2) {
    fail(`otel conformance: expected <original> <compacted>, got ${files.length} file argument(s)\n${USAGE}`);
  }

  const [originalPath, compactedPath] = files;
  const original = readContext('otel', originalPath);
  const compacted = readContext('otel', compactedPath);

  let attrs;
  try {
    const result = scoreConformance(original, compacted, {
      match,
      strict,
      onWarning: (msg, source) => {
        const label = source === 'compacted' ? compactedPath : originalPath;
        process.stderr.write(`warning: ${label}: ${msg}\n`);
      },
    });
    attrs = conformanceToSpanAttributes(result);
  } catch (err) {
    fail(`otel: ${err.message}`);
  }
  process.stdout.write(JSON.stringify(attrs, null, 2) + '\n');
}

// `cg otel budget [caps] <read-log-json|->` — print a budget report as
// OpenTelemetry span attributes (JSON), reusing the `budget` plumbing. A pure
// printer: always exits 0 on success (no over-budget exit-2 gate).
function cmdOtelBudget(args) {
  const budget = {};
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a === '--max-tokens') budget.max_tokens = parseCap('otel', a, args[++i]);
    else if (a === '--max-files') budget.max_files = parseCap('otel', a, args[++i]);
    else if (a === '--max-tokens-per-file') budget.max_tokens_per_file = parseCap('otel', a, args[++i]);
    else if (a.startsWith('-') && a !== '-') fail(`otel: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length !== 1) {
    fail(`otel budget: expected one <read-log-json|->, got ${files.length} argument(s)\n${USAGE}`);
  }

  const reads = readReadLog('otel', files[0]);
  const hasCap = Object.keys(budget).length > 0;
  const attrs = budgetToSpanAttributes(budgetReport(reads, hasCap ? budget : undefined));
  process.stdout.write(JSON.stringify(attrs, null, 2) + '\n');
}

// `cg hook <event>` — adapt Claude Code's compaction hooks to the shipped
// `extract`/`pin` operations (#22). Each event reads the hook JSON on stdin and,
// for `session-start`, writes `additionalContext` JSON to stdout. The engine
// lives in `src/hook.js` and NEVER throws or exits non-zero on a hook error, so
// a hook can't break the user's session; this shell just wires in real I/O.
function cmdHook(args) {
  const [mode] = args;
  switch (mode) {
    case 'pre-compact':
      return runHook(runPreCompact, { readFileSync, readCache, writeCache });
    case 'session-start':
      return runHook(runSessionStart, { readCache });
    case '-h':
    case '--help':
      return void process.stdout.write(USAGE + '\n');
    case undefined:
      return fail(`hook: an event is required (pre-compact | session-start)\n${USAGE}`);
    default:
      return fail(`hook: unknown event ${JSON.stringify(mode)} (expected pre-compact | session-start)\n${USAGE}`);
  }
}

// Read all of stdin (fd 0), run a hook function, and honor its result. Reading
// stdin can fail (empty/closed) — that yields '', which the hook parses into a
// silent no-op. The exit code is always 0 in practice, but we honor whatever
// the hook returns explicitly.
function runHook(fn, deps) {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    stdin = '';
  }
  const result = fn(stdin, deps);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

// Per-session constraint cache under the OS temp dir (no repo pollution, no
// gitignore entry). One JSON file per session, holding the constraint set
// exactly as `extract`/`pin` produce and consume it.
function cacheFile(sessionId) {
  return join(tmpdir(), 'constraintguard', `${safeSessionKey(sessionId)}.json`);
}

// Load a session's cached set, or [] when absent or unreadable/corrupt. Never
// throws — a bad cache degrades to "nothing cached", preserving the hook's
// never-break-the-session contract.
function readCache(sessionId) {
  try {
    return JSON.parse(readFileSync(cacheFile(sessionId), 'utf8'));
  } catch {
    return [];
  }
}

// Persist a session's constraint set, creating the cache dir on first write.
function writeCache(sessionId, set) {
  const path = cacheFile(sessionId);
  mkdirSync(join(tmpdir(), 'constraintguard'), { recursive: true });
  writeFileSync(path, JSON.stringify(set));
}

// Read a context file, failing (exit 1) with a clear message if unreadable.
// The warnings emitted by scoreConformance are already tagged with the file
// path they came from, so callers can tell the two contexts apart.
function readContext(cmd, path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    fail(`${cmd}: cannot read ${path}: ${err.message}`);
  }
}

// Human-readable conformance report.
function formatConformance(result) {
  const { score, total, survived, dropped } = result;
  const pct = score.toFixed(2);
  let head = `Conformance: ${pct}  (${survived}/${total} constraints survived)`;
  if (total === 0) {
    return `Conformance: ${pct}  (0/0) — no constraints declared in the original context`;
  }
  if (dropped.length === 0) return head;

  const lines = [head, `Dropped (${dropped.length}):`];
  for (const c of dropped) lines.push(`  - ${c.severity} [${c.id}]: ${c.text}`);
  return lines.join('\n');
}

// Human-readable budget report.
function formatBudget(report) {
  const { total_tokens, file_count, waste_ratio, unused, unused_tokens, over_budget, overages } = report;
  const pct = (waste_ratio * 100).toFixed(1);
  const lines = [
    `Budget: ${total_tokens} tokens across ${file_count} file(s); ${unused_tokens} wasted (${pct}%)${over_budget ? ' — OVER BUDGET' : ''}`,
  ];
  if (overages.length > 0) {
    lines.push(`Over (${overages.length}):`);
    for (const o of overages) lines.push(`  - ${o.cap}: ${o.actual} > ${o.limit}`);
  }
  if (unused.length > 0) {
    lines.push(`Unused (${unused.length}):`);
    for (const u of unused) lines.push(`  - ${u.path} (${u.tokens} tokens)`);
  }
  return lines.join('\n');
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

main(process.argv.slice(2));
