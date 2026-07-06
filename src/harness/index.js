// Harness adapter registry (#13).
//
// An adapter is a pure function `(raw, opts) → string` that converts a
// harness-native artifact into the plain-text context `cg extract` (#2) already
// consumes. `text` is the identity adapter — today's behavior, returned
// verbatim — so omitting `--harness` is a no-op. `claude-code` isolates the
// operator's text from a Claude Code `.jsonl` transcript. Adding a harness
// (Codex, per the roadmap) is a one-line registry entry.

import { extractConstraints } from '../extract.js';
import { claudeCodeToContext } from './claude-code.js';

const ADAPTERS = {
  text: (raw) => raw,
  'claude-code': claudeCodeToContext,
};

// Supported harness names, for usage/error text.
export const HARNESSES = Object.keys(ADAPTERS);

// Run `raw` through the named adapter, returning the isolated context string.
// Throws a clear Error naming the supported harnesses on an unknown name.
export function adaptHarness(name, raw, opts = {}) {
  const adapter = ADAPTERS[name];
  if (adapter == null) {
    throw new Error(`unknown harness ${JSON.stringify(name)} (supported: ${HARNESSES.join(', ')})`);
  }
  return adapter(raw, opts);
}

// Convenience: transcript-string → constraint set in one call, for programmatic
// callers who don't want the CLI. Adapts, then runs the existing extractor.
export function extractFromHarness(name, raw, opts = {}) {
  return extractConstraints(adaptHarness(name, raw, opts), opts);
}
