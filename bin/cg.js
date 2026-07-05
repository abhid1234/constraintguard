#!/usr/bin/env node
// ConstraintGuard CLI. Subcommands are added issue-by-issue; today: `extract`,
// `pin`. Future subcommands (`validate`, `conformance`) slot in as sibling
// cases in main(). Zero dependencies: Node standard library only.

import { readFileSync } from 'node:fs';
import { extractConstraints, pinConstraints, validateConstraintSet } from '../src/index.js';

const USAGE = [
  'usage:',
  '  cg extract [--strict] <context-file>',
  '  cg pin [<constraints-file>|-] <context-file>',
].join('\n');

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'extract':
      return cmdExtract(rest);
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

// `cg pin [<constraints-file>|-] <context-file>` — inject a constraint set into
// a context and print the result to stdout. The set comes from a JSON file, or
// from piped stdin when the constraints argument is `-` or omitted.
function cmdPin(args) {
  const files = [];
  for (const a of args) {
    if (a === '-h' || a === '--help') return void process.stdout.write(USAGE + '\n');
    else if (a.startsWith('-') && a !== '-') fail(`pin: unknown option ${JSON.stringify(a)}\n${USAGE}`);
    else files.push(a);
  }
  if (files.length === 0) fail(`pin: a context file is required\n${USAGE}`);
  if (files.length > 2) fail(`pin: expected at most a constraints file and a context file, got ${files.length}\n${USAGE}`);

  // One positional → constraints on stdin; two → first is the constraints file
  // ('-' also means stdin).
  const constraintsSource = files.length === 2 ? files[0] : '-';
  const contextFile = files.length === 2 ? files[1] : files[0];

  let rawSet;
  try {
    rawSet = constraintsSource === '-' ? readFileSync(0, 'utf8') : readFileSync(constraintsSource, 'utf8');
  } catch (err) {
    const where = constraintsSource === '-' ? 'stdin' : constraintsSource;
    fail(`pin: cannot read constraints from ${where}: ${err.message}`);
  }

  let set;
  try {
    set = validateConstraintSet(JSON.parse(rawSet));
  } catch (err) {
    fail(`pin: invalid constraint set: ${err.message}`);
  }

  let context;
  try {
    context = readFileSync(contextFile, 'utf8');
  } catch (err) {
    fail(`pin: cannot read ${contextFile}: ${err.message}`);
  }

  let out;
  try {
    out = pinConstraints(set, context);
  } catch (err) {
    fail(`pin: ${err.message}`);
  }
  process.stdout.write(out);
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

main(process.argv.slice(2));
