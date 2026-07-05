#!/usr/bin/env node
// ConstraintGuard CLI. Subcommands are added issue-by-issue; today: `extract`.
// Future subcommands (`validate`, `pin`, `conformance`) slot in as sibling
// cases in main(). Zero dependencies: Node standard library only.

import { readFileSync } from 'node:fs';
import { extractConstraints } from '../src/index.js';

const USAGE = 'usage: cg extract [--strict] <context-file>';

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'extract':
      return cmdExtract(rest);
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

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

main(process.argv.slice(2));
