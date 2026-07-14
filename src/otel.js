// `cg otel` — map ConstraintGuard data to OpenTelemetry span attributes.
//
// Observability stacks (Arize / LangSmith / Braintrust) key traces on flat span
// attributes: a `string → (string | number | boolean | primitive[])` map, never
// a nested object. This module turns ConstraintGuard's two stable data models —
// a constraint set (`{ id, text, severity }[]`, #1/#2) and a conformance result
// (`{ score, total, survived, dropped }`, #8) — into such a map under the stable
// `constraintguard.*` namespace, so a caller can attach "which constraints were
// declared / dropped" to whatever span their existing exporter already produces.
//
// Dependency-free by design: this produces the attribute *shape* only; it does
// NOT import the OpenTelemetry SDK and never creates spans, tracers, or
// exporters. Pure and deterministic: no I/O, no wall-clock, no randomness. Every
// returned value is OTel-legal (a string, a finite number, or a homogeneous
// array of strings) so the object can be spread straight into
// `span.setAttributes(...)`. Zero dependencies beyond `validateConstraintSet`.

import { validateConstraintSet } from './schema.js';

// The reserved prefix for every attribute key. Centralized so a reviewer-driven
// namespace rename is a one-line change (PRODUCT flags namespace as the gate).
const NS = 'constraintguard';

// Map a constraint set to a flat OTel span-attribute object under
// `constraintguard.constraints.*`. Validates `set` against the #1 schema first,
// so a malformed set throws rather than producing garbage attributes. Always
// returns exactly four keys; an empty set yields the zeroed object (never `{}`),
// so a consumer can read every key unconditionally.
export function constraintsToSpanAttributes(set) {
  validateConstraintSet(set);

  const ids = [];
  let must = 0;
  let should = 0;
  for (const c of set) {
    ids.push(c.id);
    if (c.severity === 'must') must++;
    else should++;
  }

  return {
    [`${NS}.constraints.count`]: set.length,
    [`${NS}.constraints.ids`]: ids,
    [`${NS}.constraints.severity.must`]: must,
    [`${NS}.constraints.severity.should`]: should,
  };
}

// Map a conformance result (`{ score, total, survived, dropped }`, as returned
// by `scoreConformance`, #8) to a flat OTel span-attribute object under
// `constraintguard.conformance.*`. Emits the exact `score` float (not the
// display-rounded value), and separates the drop count (scalar) from the drop
// ids (array) under a `dropped` sub-namespace so the keys never collide. Reads
// `dropped` defensively (a missing array means no drops); assumes an otherwise
// well-formed result.
export function conformanceToSpanAttributes(result) {
  const dropped = Array.isArray(result.dropped) ? result.dropped : [];
  return {
    [`${NS}.conformance.score`]: result.score,
    [`${NS}.conformance.total`]: result.total,
    [`${NS}.conformance.survived`]: result.survived,
    [`${NS}.conformance.dropped.count`]: dropped.length,
    [`${NS}.conformance.dropped.ids`]: dropped.map((c) => c.id),
  };
}

// Map a budget report (`{ total_tokens, file_count, over_budget, overages,
// unused, unused_tokens, utilization, waste_ratio }`, as returned by
// `budgetReport`, #context-budget) to a flat OTel span-attribute object under
// `constraintguard.budget.*`. Emits the exact `utilization`/`waste_ratio` floats
// (not display-rounded), the `over_budget` boolean so a dashboard can alert on
// leaky context, and the unused paths + blown cap names (scalar counts kept
// separate from the arrays under a sub-namespace, so keys never collide). Reads
// each field defensively (missing arrays mean "none"); assumes an otherwise
// well-formed report. Every value is OTel-legal (string, finite number, boolean,
// or homogeneous string array), so it spreads straight into `span.setAttributes`.
export function budgetToSpanAttributes(report) {
  const overages = Array.isArray(report.overages) ? report.overages : [];
  const unused = Array.isArray(report.unused) ? report.unused : [];
  const used_tokens = report.total_tokens - report.unused_tokens;
  return {
    [`${NS}.budget.total_tokens`]: report.total_tokens,
    [`${NS}.budget.file_count`]: report.file_count,
    [`${NS}.budget.used_tokens`]: used_tokens,
    [`${NS}.budget.unused_tokens`]: report.unused_tokens,
    [`${NS}.budget.utilization`]: report.utilization,
    [`${NS}.budget.waste_ratio`]: report.waste_ratio,
    [`${NS}.budget.over_budget`]: report.over_budget,
    [`${NS}.budget.unused.count`]: unused.length,
    [`${NS}.budget.unused.paths`]: unused.map((u) => u.path),
    [`${NS}.budget.overages.caps`]: overages.map((o) => o.cap),
  };
}
