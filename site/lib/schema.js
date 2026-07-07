// The constraint schema — the foundation everything else builds on.
//
// A `constraint` is a plain JSON object with a stable shape:
//   { id: string, text: string, severity: "must" | "should" }
// A `constraint set` is a list of these. This module validates that shape.
// Zero dependencies: Node standard library only.

const SEVERITIES = ['must', 'should'];

// Validate a constraint set. Returns the set unchanged on success, or throws an
// Error naming the first problem found (missing field, wrong type, duplicate id).
export function validateConstraintSet(obj) {
  if (!Array.isArray(obj)) {
    throw new Error(`constraint set must be an array, got ${describe(obj)}`);
  }

  const seen = new Set();
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    const at = `constraint at index ${i}`;

    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`${at} must be an object, got ${describe(c)}`);
    }

    if (!('id' in c)) throw new Error(`${at} is missing required field "id"`);
    if (typeof c.id !== 'string') {
      throw new Error(`${at} field "id" must be a string, got ${describe(c.id)}`);
    }
    if (c.id === '') throw new Error(`${at} field "id" must not be empty`);

    if (!('text' in c)) throw new Error(`constraint "${c.id}" is missing required field "text"`);
    if (typeof c.text !== 'string') {
      throw new Error(`constraint "${c.id}" field "text" must be a string, got ${describe(c.text)}`);
    }

    if (!('severity' in c)) throw new Error(`constraint "${c.id}" is missing required field "severity"`);
    if (!SEVERITIES.includes(c.severity)) {
      throw new Error(
        `constraint "${c.id}" field "severity" must be one of ${SEVERITIES.map((s) => `"${s}"`).join(' | ')}, got ${describe(c.severity)}`,
      );
    }

    if (seen.has(c.id)) throw new Error(`duplicate constraint id "${c.id}"`);
    seen.add(c.id);
  }

  return obj;
}

// A short, human-readable description of a value for error messages.
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return typeof value;
}
