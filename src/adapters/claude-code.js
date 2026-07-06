// Claude Code adapter — turn a live agent's session transcript into a context
// string that `extractConstraints` can read.
//
// A Claude Code session is stored as JSON Lines (`.jsonl`): one JSON record per
// line, under `~/.claude/projects/<slug>/<session>.jsonl`. This adapter reads
// the operator-authored text of that session — the message content of `user`
// records — and concatenates it into a single context string. It does NOT parse
// constraints itself: it only isolates the constraint-bearing text and hands it
// to the existing #2 `extract` logic.
//
// Why only `user` records: in Claude Code the declared rules (the system prompt,
// injected CLAUDE.md `<system-reminder>`s, and any re-pinned constraints from
// `cg pin`) all surface as the text of `user`-role message content — Claude Code
// transcripts persist no `system` record. The `assistant` role is the model's
// own output — not a source of *declared* constraints — so it is skipped, as are
// tool calls, tool results, internal `thinking`, and bookkeeping records
// (summaries, queue operations). Combined with `extract`'s explicit
// ```constraints fence opt-in, this keeps the false-positive rate near zero
// while picking up every constraint block the operator declared anywhere in the
// session.
//
// Pure and deterministic: parsing only, no I/O, no wall-clock, no randomness.
// Zero dependencies. A Codex adapter can follow the same shape later.

// Message roles whose content we treat as constraint-bearing. Only `user`:
// PRODUCT scopes extraction to user-role text, and a Claude Code transcript
// persists no `system` record — so a fence in any non-user record is a decoy.
const READ_ROLES = new Set(['user']);

// Convert a Claude Code `.jsonl` transcript into a plain context string.
//   opts.onWarning — called with a human-readable message for each skipped line
//                    (default: noop).
// A malformed / truncated transcript line is always warned-and-skipped, never
// fatal — even under `--strict`. Transcript framing is append-only, so a
// half-written last line must never crash the tool; `--strict` is scoped to
// constraint-line strictness in `extractConstraints`, not to line framing, and
// so is not consumed here.
// Returns the concatenated constraint-bearing text (possibly empty). The result
// is meant to be passed straight to `extractConstraints`.
export function claudeCodeToContext(jsonl, opts = {}) {
  if (typeof jsonl !== 'string') {
    throw new Error(
      `claude-code adapter expects a string, got ${jsonl === null ? 'null' : typeof jsonl}`,
    );
  }
  const warn = typeof opts.onWarning === 'function' ? opts.onWarning : () => {};

  const chunks = [];
  const lines = jsonl.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue; // blank lines between records (or a trailing newline)

    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (err) {
      // Never fatal, even under --strict: an append-only transcript can end on a
      // half-written line, and that must not crash extraction.
      warn(`line ${i + 1}: not valid JSON, skipping: ${err.message}`);
      continue;
    }

    const message = rec != null ? rec.message : null;
    const role = message != null ? message.role : undefined;
    if (message == null || !READ_ROLES.has(role)) continue;

    const text = collectText(message.content).trim();
    if (text !== '') chunks.push(text);
  }

  // Blank line between records so a fence opened in one never runs into the next.
  return chunks.join('\n\n');
}

// Pull the human-readable text out of a message `content` value, which may be a
// plain string or an array of content blocks. We keep string blocks and `text`
// blocks; everything else (tool_use params, tool_result output, images, and
// internal `thinking`) carries no declared constraint and is dropped.
function collectText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block != null && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.filter((p) => p !== '').join('\n\n');
}
