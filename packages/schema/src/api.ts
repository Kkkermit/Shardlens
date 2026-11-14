/**
 * Collector replies the SDK depends on. The collector builds them with these schemas; the SDK (which has no zod at
 * runtime) checks their shape by hand, so keep them small and stable.
 */
import { z } from 'zod';
import { Mode, Snowflake } from './wire.js';

export const SaltPeriod = z.enum(['day', 'week', 'month']);

/** 32 random bytes, base64url without padding. */
export const SaltB64 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `GET /v1/config` (ingest key): salts for the current and previous period, sampling and mode. */
export const ConfigResponse = z.object({
  v: z.literal(1),
  appId: Snowflake,
  mode: Mode,
  saltPeriod: SaltPeriod,
  /** Current period first. Destroyed salts are never served. */
  salts: z.array(z.object({ period: z.string().max(16), salt: SaltB64 })).max(2),
  /** Per event type sample rate in (0, 1]. Missing types are kept at 1. */
  sampling: z.record(z.string().max(32), z.number().gt(0).max(1)).default({}),
  serverTime: z.iso.datetime(),
});

/** `POST /v1/ingest` 202 reply. `rejected` lists events dropped by validation (by index in the batch). */
export const IngestAccepted = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.array(z.object({ index: z.number().int().nonnegative(), reason: z.string().max(64) })).default([]),
});

export const ErrorResponse = z.object({
  error: z.string().max(64),
  message: z.string().max(500).optional(),
  rejected: z.array(z.object({ index: z.number().int().nonnegative(), reason: z.string().max(64) })).optional(),
});

export type SaltPeriod = z.infer<typeof SaltPeriod>;
export type ConfigResponse = z.output<typeof ConfigResponse>;
export type IngestAccepted = z.output<typeof IngestAccepted>;
export type ErrorResponse = z.output<typeof ErrorResponse>;
