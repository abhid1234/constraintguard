// Claude Code harness adapter (#13).
//
// Converts a Claude Code session transcript — the append-only `.jsonl` log
// under `~/.claude/projects/<slug>/` — into the same plain-text context that
// `cg extract` (#2) already consumes. It isolates the *operator's* text: the
// `text` of every top-level `user` record, joined in transcript order. That is
// where declared constraints live; assistant turns, tool calls, tool results,
// thinking blocks, and non-message records are all excluded, which closes the
// tool-result false positive (an agent that reads a file containing an example
// ```constraints``` block must not have those constraints extracted).
//
// The parse is maximally tolerant of a live, half-written log: each line is
// JSON-parsed in isolation and a malformed line is warned-and-skipped, never
// fatal — even under `strict` (which is scoped to constraint-line strictness in
// #2, not transcript parsing). Pure and deterministic: no I/O, no clock, no
// randomness, zero dependencies.

// Turn a raw `.jsonl` transcript into the isolated constraint-bearing context.
//   opts.onWarning — called with a human-readable message for each skipped
//                    (malformed) transcript line (default: noop). Same shape as
//                    `extractConstraints`'s `onWarning`, so the CLI can reuse it.
// Returns a string: the `user`-role text joined with blank lines, ready to hand
// straight to `extractConstraints`.
export function claudeCodeToContext(raw, opts = {}) {
  if (typeof raw !== 'string') {
    throw new Error(`claude-code adapter expects a string, got ${raw === null ? 'null' : typeof raw}`);
  }
  const warn = typeof opts.onWarning === 'function' ? opts.onWarning : () => {};

  const lines = raw.split(/\r?\n/);
  const texts = [];
  let parsedAny = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // blank/whitespace-only: not a record

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A truncated final line in an append-only log is expected, not an error.
      warn(`transcript line ${i + 1}: not valid JSON, skipping`);
      continue;
    }
    parsedAny = true;

    // Allow-list by top-level type: only the operator's own turns (v1 scope).
    if (record == null || record.type !== 'user') continue;
    const message = record.message;
    if (message == null || typeof message !== 'object') continue;

    const content = message.content;
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      // Take only `text` blocks; ignore tool_use / tool_result / image / etc.
      for (const block of content) {
        if (block != null && block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
    }
  }

  // A non-empty file that yielded zero parseable records is almost certainly not
  // a Claude Code transcript (e.g. plain markdown passed to --harness claude-code).
  // Flag it so a silently-empty result isn't mistaken for "no constraints".
  if (!parsedAny && raw.trim() !== '') {
    warn('no valid Claude Code transcript records found — is this a .jsonl transcript?');
  }

  // Blank line between turns so a `constraints` fence never welds onto adjacent
  // text and each fence stays independently detectable by #2's line scanner.
  return texts.join('\n\n');
}
