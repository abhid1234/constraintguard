// `cg hook <event>` core — adapt Claude Code's hook protocol to the shipped
// `extract` (#2/#13) and `pin` (#7) operations so the extract→pin loop closes
// automatically across a compaction (#22). This module is the pure-ish engine:
// all I/O (reading the transcript, reading/writing the per-session cache) is
// injected via a `deps` object so it is unit-testable without touching the real
// filesystem. `bin/cg.js` is the thin shell that wires in real `fs`/`os` and
// stdin. Zero dependencies: Node standard library only.
//
// The hook protocol we depend on (Claude Code):
//   - PreCompact stdin (fields we use): `session_id`, `transcript_path`,
//     `hook_event_name: "PreCompact"`, `trigger: "manual" | "auto"`. No stdout
//     is consumed for this event — its only job is to stash the constraint set.
//   - SessionStart stdin (fields we use): `session_id`,
//     `hook_event_name: "SessionStart"`, `source: "startup" | "resume" |
//     "clear" | "compact"`. Stdout, when it is
//     `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`,
//     is appended to the freshly compacted context.
//
// Failure contract (the single most important invariant): a hook that exits
// non-zero or prints malformed control JSON can disrupt the session. Therefore
// EVERY path here resolves to `{ exitCode: 0, stdout: '' }` on error, optionally
// with a `stderr` note. We never throw out of a hook command.

import { extractFromHarness } from './harness/index.js';
import { pinConstraints } from './pin.js';
import { validateConstraintSet } from './schema.js';

// Prefix line on the re-injected block, explaining to the model why these
// constraints reappeared post-compaction.
export const INSTRUCTION =
  'The constraints below were declared earlier this session and must continue to hold after compaction:';

// PreCompact: extract the session's declared constraints from `transcript_path`
// and union them into the per-session cache. Emits no stdout. `deps` is
// `{ readFileSync, readCache, writeCache }` where readCache(sessionId) → set
// (or [] when absent) and writeCache(sessionId, set) persists it.
export function runPreCompact(stdin, deps) {
  try {
    const payload = parsePayload(stdin);
    const sessionId = payload.session_id;
    const transcriptPath = payload.transcript_path;
    if (!sessionId || !transcriptPath) {
      // Nothing to key or read against — a silent no-op, not an error.
      return { exitCode: 0, stdout: '' };
    }

    const raw = deps.readFileSync(transcriptPath, 'utf8');
    const extracted = extractFromHarness('claude-code', raw, { onWarning: () => {} });
    const merged = unionById(deps.readCache(sessionId), extracted);
    deps.writeCache(sessionId, merged);
    return { exitCode: 0, stdout: '' };
  } catch (err) {
    return { exitCode: 0, stdout: '', stderr: `cg hook pre-compact: ${err.message}\n` };
  }
}

// SessionStart(compact): re-inject the cached constraints as the hook's
// `additionalContext`. Silent (empty stdout, exit 0) for any non-compact
// source, a missing cache, or an empty set. `deps` is `{ readCache }`.
export function runSessionStart(stdin, deps) {
  try {
    const payload = parsePayload(stdin);
    if (payload.source !== 'compact') return { exitCode: 0, stdout: '' };

    const sessionId = payload.session_id;
    if (!sessionId) return { exitCode: 0, stdout: '' };

    const set = unionById([], deps.readCache(sessionId)); // validate + normalize
    if (set.length === 0) return { exitCode: 0, stdout: '' };

    // `pinConstraints(set, '')` renders exactly the bare ```constraints``` block.
    const block = pinConstraints(set, '');
    const additionalContext = `${INSTRUCTION}\n\n${block.endsWith('\n') ? block.slice(0, -1) : block}`;
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: 0, stdout: '', stderr: `cg hook session-start: ${err.message}\n` };
  }
}

// Tolerant hook-payload parse: returns `{}` on any failure so downstream field
// reads simply no-op (the failure contract turns them into silent exits).
export function parsePayload(stdin) {
  try {
    const obj = JSON.parse(stdin);
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

// Union two constraint sets by `id`, keeping the FIRST occurrence's text and
// severity on collision (mirrors `extract`'s id-conflict rule). Non-array or
// malformed inputs are treated as empty. The result is re-validated so a corrupt
// cache can never propagate downstream.
export function unionById(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const c of [...toSet(existing), ...toSet(incoming)]) {
    if (c == null || typeof c !== 'object' || typeof c.id !== 'string' || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return validateConstraintSet(out);
}

function toSet(value) {
  return Array.isArray(value) ? value : [];
}

// Turn a `session_id` into a safe cache-file basename: anything outside
// `[A-Za-z0-9._-]` becomes `_` (defense against path traversal; real ids are
// UUIDs). Used by the real `deps` in `bin/cg.js`.
export function safeSessionKey(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}
