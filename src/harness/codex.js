// Codex harness adapter (#23).
//
// Converts an OpenAI Codex CLI session — the append-only `.jsonl` *rollout* log
// under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` — into the same
// plain-text context that `cg extract` (#2) already consumes. Every rollout line
// is an envelope `{ timestamp, type, payload }`; the operator's own turns are
// `response_item` lines whose payload is a Responses-API message with
// `role: "user"`:
//
//   {"type":"response_item","payload":{"type":"message","role":"user",
//     "content":[{"type":"input_text","text":"…the operator's text…"}]}}
//
// The adapter isolates exactly those records — `type === "response_item"` AND
// `payload.type === "message"` AND `payload.role === "user"` — pulls the `text`
// of every `input_text` block, and joins them in rollout order. Assistant
// messages (`output_text`), tool calls / `function_call_output` output,
// `reasoning` items, `session_meta`, and all `event_msg` lines (including the
// `user_message` UI echo) are excluded. That closes the tool-result false
// positive (a file the agent read that contains an example ```constraints```
// block must not be extracted) and, by targeting only the canonical
// `response_item` stream and never the duplicate `event_msg` echo, avoids
// double-counting the operator's text.
//
// The parse is maximally tolerant of a live, half-written log: each line is
// JSON-parsed in isolation and a malformed line is warned-and-skipped, never
// fatal — even under `strict` (which is scoped to constraint-line strictness in
// #2, not rollout parsing). Pure and deterministic: no I/O, no clock, no
// randomness, zero dependencies. Structurally this is the Claude Code adapter
// (#13) with a Codex record filter.

// Turn a raw rollout `.jsonl` into the isolated constraint-bearing context.
//   opts.onWarning — called with a human-readable message for each skipped
//                    (malformed) rollout line (default: noop). Same shape as
//                    `extractConstraints`'s `onWarning`, so the CLI can reuse it.
// Returns a string: the operator's `response_item` user text joined with blank
// lines, ready to hand straight to `extractConstraints`.
export function codexToContext(raw, opts = {}) {
  if (typeof raw !== 'string') {
    throw new Error(`codex adapter expects a string, got ${raw === null ? 'null' : typeof raw}`);
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
      warn(`rollout line ${i + 1}: not valid JSON, skipping`);
      continue;
    }
    parsedAny = true;

    // Allow-list by envelope + payload shape: only the operator's own turns.
    if (record == null || record.type !== 'response_item') continue;
    const payload = record.payload;
    if (payload == null || typeof payload !== 'object') continue;
    if (payload.type !== 'message' || payload.role !== 'user') continue;

    const content = payload.content;
    if (typeof content === 'string') {
      texts.push(content); // defensive; Codex uses arrays
    } else if (Array.isArray(content)) {
      // Take only `input_text` blocks; ignore input_image / other block types.
      for (const block of content) {
        if (block != null && block.type === 'input_text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
    }
  }

  // A non-empty file that yielded zero parseable records is almost certainly not
  // a Codex rollout (e.g. plain markdown passed to --harness codex). Flag it so a
  // silently-empty result isn't mistaken for "no constraints".
  if (!parsedAny && raw.trim() !== '') {
    warn('no valid Codex rollout records found — is this a .jsonl rollout?');
  }

  // Blank line between turns so a `constraints` fence never welds onto adjacent
  // text and each fence stays independently detectable by #2's line scanner.
  return texts.join('\n\n');
}
