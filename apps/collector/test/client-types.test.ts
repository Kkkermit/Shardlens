import { type QuerySpec as ClientQuerySpec, createShardlensClient, type QueryResults } from '@shardlens/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { QuerySpec } from '../src/query/spec.js';

// `@shardlens/client` has no dependencies, so its query types are written by hand. These checks fail `pnpm check`
// (the type ones through `tsc`) when a query kind or field is added, removed or changed here and not there.

/** What a caller may send: the schema's input side, where fields with a default are optional. */
type CollectorQuerySpec = z.input<typeof QuerySpec>;

/** The client takes read-only arrays, so `as const` specs fit; zod's are mutable. Nothing else differs. */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

/** One property per kind, so a mismatch is reported under the kind it is in. */
type ByKind<S extends { kind: string }> = { [K in S['kind']]: Extract<S, { kind: K }> };

describe('@shardlens/client stays in step with the query schema', () => {
  it('types every query spec exactly as the schema reads it', () => {
    expectTypeOf<ByKind<Mutable<ClientQuerySpec>>>().toEqualTypeOf<ByKind<CollectorQuerySpec>>();
  });

  it('types an answer for every kind', () => {
    expectTypeOf<keyof QueryResults>().toEqualTypeOf<CollectorQuerySpec['kind']>();
  });

  it('has a method for every kind', () => {
    const kinds = QuerySpec.options.map((option) => option.shape.kind.value);
    expect(kinds).toHaveLength(19);
    const client = createShardlensClient({ url: 'https://stats.example.com', key: `slk_read_${'x'.repeat(43)}` });
    for (const kind of kinds) expect(client[kind], kind).toBeTypeOf('function');
  });
});
