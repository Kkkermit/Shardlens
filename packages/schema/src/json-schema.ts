import { z } from 'zod';
import { Batch, Event } from './wire.js';

const NO_NUL = '^[^\\u0000]*$';

/**
 * The JSON Schema (draft 2020-12) of a batch as an SDK sends it, published as `@shardlens/schema/batch.schema.json`.
 * It also states the two rules checked in code: no string may hold a NUL character (`parseBatch()` refuses them,
 * since PostgreSQL can't store one), and in privacy mode no event may carry an `actor` (`privacyViolation()`).
 */
export function batchJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(Batch, {
    io: 'input',
    target: 'draft-2020-12',
    override: ({ jsonSchema }) => {
      const { type, pattern, const: constant, enum: values } = jsonSchema;
      // A string with a pattern, a constant or a list of values can't hold a NUL already.
      if (type === 'string' && pattern === undefined && constant === undefined && values === undefined) {
        jsonSchema.pattern = NO_NUL;
      }
    },
  });
  const withActor = Event.options.filter((option) => 'actor' in option.shape).map((option) => option.shape.type.value);
  return {
    ...schema,
    $id: 'https://github.com/Kkkermit/Shardlens/schema/batch-v1.json',
    title: 'Shardlens batch (wire format v1)',
    if: { properties: { mode: { const: 'privacy' } }, required: ['mode'] },
    // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, holding an object, not a callback
    then: {
      properties: {
        events: { items: { not: { required: ['type', 'actor'], properties: { type: { enum: withActor } } } } },
      },
    },
  };
}
