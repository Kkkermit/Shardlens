import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Batch, batchJsonSchema, Event, privacyViolation } from '../src/index.js';
import { interaction, messageCommand } from './fixtures.js';

type Node = Record<string, unknown>;

/** Every subschema of a JSON Schema, with its path. */
function* walk(node: unknown, path = ''): Generator<[string, Node]> {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* walk(item, `${path}[${i}]`);
  } else if (typeof node === 'object' && node !== null) {
    yield [path, node as Node];
    for (const [key, value] of Object.entries(node)) yield* walk(value, `${path}/${key}`);
  }
}

describe('batch JSON Schema', () => {
  const schema = batchJsonSchema();

  it('runs no check in zod that it cannot state, other than the privacy rule on the whole batch', () => {
    // A `.refine()` is invisible to JSON Schema users, and one that throws on bad input takes parseBatch down with it.
    const refined: string[] = [];
    z.toJSONSchema(Batch, {
      io: 'input',
      override: ({ zodSchema, path }) => {
        if (zodSchema._zod.def.checks?.some((check) => check._zod.def.check === 'custom')) refined.push(path.join('.'));
      },
    });
    expect(refined).toEqual(['']);
  });

  it('states the privacy rule for exactly the event types that can carry an actor', () => {
    const actor = { userId: '112233445566778899' };
    for (const event of [interaction({ actor }), messageCommand({ actor })]) {
      expect(privacyViolation(Event.parse(event), 'privacy')).toBe('actor_in_privacy_mode');
    }
    const carriers = Event.options.filter((option) => 'actor' in option.shape).map((option) => option.shape.type.value);
    expect(carriers).toEqual(['interaction', 'message_command']);
    expect(schema.if).toEqual({ properties: { mode: { const: 'privacy' } }, required: ['mode'] });
    expect(schema.then).toEqual({
      properties: {
        events: { items: { not: { required: ['type', 'actor'], properties: { type: { enum: carriers } } } } },
      },
    });
  });

  it('refuses NUL characters in every string a person or a bot can fill with text', () => {
    const open = [...walk(schema)]
      .filter(([, node]) => node.type === 'string' && node.const === undefined && node.enum === undefined)
      .filter(([, node]) => typeof node.pattern !== 'string' || new RegExp(node.pattern, 'u').test('a\u0000b'));
    expect(open.map(([path]) => path)).toEqual([]);
  });

  it('leaves the patterns of IDs, hashes and dates in place', () => {
    const datetime = (schema.properties as Record<string, Node>).sentAt;
    expect(datetime?.format).toBe('date-time');
    expect(new RegExp(String(datetime?.pattern), 'u').test('2026-11-13T16:42:01.234Z')).toBe(true);
  });
});
