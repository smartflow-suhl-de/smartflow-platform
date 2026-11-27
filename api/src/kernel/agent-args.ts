/**
 * The argument check between a model's tool call and a plugin's `run`.
 *
 * The model writes the arguments; the plugin must never receive anything but
 * the narrow shape its schema declares. Only the JSON-schema subset the
 * sources actually use is supported — a source whose schema needs more is a
 * code change, not a reason to loosen this check. Unknown keys are rejected
 * instead of ignored: a model that invents `{"sql": "…"}` must hear no.
 */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateArguments(
  sourceId: string,
  schema: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  if (schema.type !== 'object') {
    throw new ArgumentError(`${sourceId} has an unsupported argument schema`);
  }
  if (schema.additionalProperties !== false) {
    throw new ArgumentError(`${sourceId} must close its argument schema`);
  }

  const value = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(value)) throw new ArgumentError(`${sourceId} expects an object`);

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];

  const out: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(value)) {
    const property = properties[key];
    if (!isRecord(property)) throw new ArgumentError(`${sourceId} has no argument "${key}"`);
    out[key] = checkValue(key, property, rawValue);
  }

  for (const key of required) {
    if (!(key in out)) throw new ArgumentError(`${sourceId} requires "${key}"`);
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property) || key in out) continue;
    if (property.default !== undefined) out[key] = property.default;
  }

  return out;
}

function checkValue(key: string, schema: Record<string, unknown>, value: unknown): unknown {
  const allowed = Array.isArray(schema.enum)
    ? schema.enum.filter((item) => typeof item === 'string' || typeof item === 'number')
    : null;

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') throw new ArgumentError(`"${key}" must be a string`);
      const max = typeof schema.maxLength === 'number' ? schema.maxLength : null;
      if (max !== null && value.length > max) {
        throw new ArgumentError(`"${key}" is longer than ${max} characters`);
      }
      if (allowed !== null && !allowed.includes(value)) {
        throw new ArgumentError(`"${key}" has an unsupported value`);
      }
      return value;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ArgumentError(`"${key}" must be an integer`);
      }
      checkRange(key, schema, value);
      if (allowed !== null && !allowed.includes(value)) {
        throw new ArgumentError(`"${key}" has an unsupported value`);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ArgumentError(`"${key}" must be a number`);
      }
      checkRange(key, schema, value);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new ArgumentError(`"${key}" must be a boolean`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new ArgumentError(`"${key}" must be an array`);
      const items = isRecord(schema.items) ? schema.items : null;
      if (!items || items.type !== 'string') {
        throw new ArgumentError(`"${key}" only supports arrays of strings`);
      }
      const max = typeof schema.maxItems === 'number' ? schema.maxItems : null;
      if (max !== null && value.length > max) {
        throw new ArgumentError(`"${key}" has more than ${max} entries`);
      }
      for (const entry of value) {
        if (typeof entry !== 'string') throw new ArgumentError(`"${key}" must contain strings`);
      }
      return [...value];
    }
    default:
      throw new ArgumentError(`"${key}" has an unsupported type`);
  }
}

function checkRange(key: string, schema: Record<string, unknown>, value: number): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    throw new ArgumentError(`"${key}" is below ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    throw new ArgumentError(`"${key}" is above ${schema.maximum}`);
  }
}
