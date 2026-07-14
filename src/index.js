// ConstraintGuard — public entry point.
// The library is built feature-by-feature from the issues in this repo.
export const VERSION = '0.3.0';

export { validateConstraintSet } from './schema.js';
export { extractConstraints } from './extract.js';
export { scoreConformance } from './conformance.js';
export { pinConstraints } from './pin.js';
export { validateBudget, validateReadLog, budgetReport, estimateTokens } from './budget.js';
export {
  constraintsToSpanAttributes,
  conformanceToSpanAttributes,
  budgetToSpanAttributes,
} from './otel.js';
export { adaptHarness, extractFromHarness, HARNESSES } from './harness/index.js';
