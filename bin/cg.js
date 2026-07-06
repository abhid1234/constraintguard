#!/usr/bin/env node
// ConstraintGuard CLI. Subcommands are added issue-by-issue; today: `extract`,
// `conformance`, `pin`. Future subcommands (`validate`) slot in as sibling
// cases in main(). Zero dependencies: Node standard library only.

import { readFileSync } from 'node:fs';
import { extractConstraints, scoreConformance, pinConstraints } from '../src/index.js';

const USAGE = [
  'usage: cg extract [--strict] <context-file>',
  '       cg conformance [--json] [--match id|exact] [--threshold <t>] [--strict] <original> <compacted>',
  '       cg pin <constraints-json|-> <context-file>',
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
  const files = [];
  for (const a of args) {
    if (a === '--strict') strict = true;
    else if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a.startsWith('-') && a !== '-') fail(`extract: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length === 0) fail(`extract: a context file is required\n${USAGE}`);
  if (files.length > 1) fail(`extract: expected one context file, got ${files.length}\n${USAGE}`);

  const file = files[0];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    fail(`extract: cannot read ${file}: ${err.message}`);
  }

  let set;
  try {
    set = extractConstraints(text, {
      strict,
      onWarning: (msg) => process.stderr.write(`warning: ${msg}\n`),
    });
  } catch (err) {
    fail(`extract: ${err.message}`);
  }

  if (set.length === 0) process.stderr.write('note: no constraints found\n');
  process.stdout.write(JSON.stringify(set, null, 2) + '\n');
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

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

main(process.argv.slice(2));
