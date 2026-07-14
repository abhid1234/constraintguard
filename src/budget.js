// The context budget + read-log model — the second half of context integrity.
//
// ConstraintGuard's core keeps the *rules* alive across compaction; this module
// keeps the *context lean*. It audits what an agent actually loaded into context
// against an optional budget, and surfaces the loaded-but-unused waste everyone
// is chasing ("99% fewer tokens"). Two plain, open JSON shapes, mirroring the
// constraint set:
//
//   budget    — { max_tokens?, max_files?, max_tokens_per_file? } (all optional caps)
//   read-log  — [ { path: string, tokens: number, used?: boolean }, ... ]
//
// Token counts are supplied by the caller: ConstraintGuard does not tokenize, it
// audits. `estimateTokens` offers a documented chars/4 heuristic for callers who
// have no real count, but it is an estimate, not a tokenizer.
//
// A read counts as *waste* only when it is explicitly `used: false`; a read with
// no `used` flag is assumed needed, so the report never over-accuses. This keeps
// `utilization + waste_ratio === 1` exactly.
//
// Validators are non-throwing: they collect every problem into `{ valid, errors }`.
// `budgetReport` is pure and deterministic: no I/O, no wall-clock, no randomness.
// Zero dependencies: Node standard library only.

// Validate a budget. Returns { valid, errors } — never throws. An empty budget
// (`{}`, no caps) is valid. Each cap, if present, must be a finite number >= 0.
// Unknown keys are allowed (the format is open), matching the constraint set.
export function validateBudget(budget) {
  const errors = [];
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    return { valid: false, errors: [`budget must be an object, got ${describe(budget)}`] };
  }
  for (const cap of ['max_tokens', 'max_files', 'max_tokens_per_file']) {
    if (!(cap in budget)) continue;
    const v = budget[cap];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`budget field "${cap}" must be a finite number, got ${describe(v)}`);
    } else if (v < 0) {
      errors.push(`budget field "${cap}" must not be negative, got ${v}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Validate a read-log. Returns { valid, errors } — never throws, collecting every
// problem found. A read-log is an array of reads; each read needs a non-empty
// string `path` and a finite `tokens >= 0`, and an optional boolean `used`.
export function validateReadLog(reads) {
  const errors = [];
  if (!Array.isArray(reads)) {
    return { valid: false, errors: [`read-log must be an array, got ${describe(reads)}`] };
  }
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i];
    const at = `read at index ${i}`;

    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`${at} must be an object, got ${describe(r)}`);
      continue;
    }

    if (!('path' in r)) errors.push(`${at} is missing required field "path"`);
    else if (typeof r.path !== 'string') errors.push(`${at} field "path" must be a string, got ${describe(r.path)}`);
    else if (r.path === '') errors.push(`${at} field "path" must not be empty`);

    if (!('tokens' in r)) errors.push(`${at} is missing required field "tokens"`);
    else if (typeof r.tokens !== 'number' || !Number.isFinite(r.tokens)) {
      errors.push(`${at} field "tokens" must be a finite number, got ${describe(r.tokens)}`);
    } else if (r.tokens < 0) {
      errors.push(`${at} field "tokens" must not be negative, got ${r.tokens}`);
    }

    if ('used' in r && typeof r.used !== 'boolean') {
      errors.push(`${at} field "used" must be a boolean, got ${describe(r.used)}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Audit a read-log against an optional budget. Pure and deterministic. Returns:
//   total_tokens  — sum of tokens across every read.
//   file_count    — number of reads.
//   over_budget   — true iff any supplied cap is exceeded.
//   overages      — one { cap, limit, actual } per blown cap, in cap order. For
//                   max_tokens_per_file, `actual` is the worst single file's tokens.
//   unused        — reads explicitly `used: false`, as { path, tokens }, in order.
//   unused_tokens — sum of tokens over `unused`.
//   utilization   — (total_tokens - unused_tokens) / total_tokens; 1 when empty.
//   waste_ratio   — unused_tokens / total_tokens; 0 when empty.
// `utilization + waste_ratio === 1` always. Tokens are read defensively: a
// non-finite token count contributes 0, so a caller's stray field can't produce
// NaN in the report (validate first with `validateReadLog` to catch such input).
export function budgetReport(reads, budget) {
  const list = Array.isArray(reads) ? reads : [];

  let total_tokens = 0;
  let unused_tokens = 0;
  let maxFileTokens = 0;
  const unused = [];

  for (const r of list) {
    const tokens = tokenCount(r);
    total_tokens += tokens;
    if (tokens > maxFileTokens) maxFileTokens = tokens;
    if (r && r.used === false) {
      unused.push({ path: r && typeof r.path === 'string' ? r.path : '', tokens });
      unused_tokens += tokens;
    }
  }

  const file_count = list.length;
  const used_tokens = total_tokens - unused_tokens;
  const utilization = total_tokens === 0 ? 1 : used_tokens / total_tokens;
  const waste_ratio = total_tokens === 0 ? 0 : unused_tokens / total_tokens;

  const overages = [];
  if (budget && typeof budget === 'object' && !Array.isArray(budget)) {
    if (isCap(budget.max_tokens) && total_tokens > budget.max_tokens) {
      overages.push({ cap: 'max_tokens', limit: budget.max_tokens, actual: total_tokens });
    }
    if (isCap(budget.max_files) && file_count > budget.max_files) {
      overages.push({ cap: 'max_files', limit: budget.max_files, actual: file_count });
    }
    if (isCap(budget.max_tokens_per_file) && maxFileTokens > budget.max_tokens_per_file) {
      overages.push({ cap: 'max_tokens_per_file', limit: budget.max_tokens_per_file, actual: maxFileTokens });
    }
  }

  return {
    total_tokens,
    file_count,
    over_budget: overages.length > 0,
    overages,
    unused,
    unused_tokens,
    utilization,
    waste_ratio,
  };
}

// A documented, deliberately crude token estimate: ~4 characters per token, the
// common English-text rule of thumb. This is an ESTIMATE for callers with no real
// count — not a tokenizer. Prefer a real model token count in the read-log when
// you have one. Returns 0 for a non-string. Never throws.
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

// A read's token count as a finite non-negative number (non-finite → 0).
function tokenCount(r) {
  const t = r && typeof r.tokens === 'number' && Number.isFinite(r.tokens) ? r.tokens : 0;
  return t > 0 ? t : 0;
}

// True when a cap value is a usable finite non-negative number.
function isCap(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// A short, human-readable description of a value for error messages
// (mirrors src/schema.js).
function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return typeof value;
}
