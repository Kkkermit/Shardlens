import type { z } from 'zod';
import { BatchEnvelope, Event, privacyViolation } from './wire.js';

/** Why one event in a batch was refused. `index` is its position in the submitted `events` array. */
export interface EventError {
  index: number;
  reason: string;
  issues?: { path: (string | number)[]; message: string }[];
}

export type ParseBatchResult =
  | { ok: true; envelope: Omit<BatchEnvelope, 'events'>; events: Event[]; errors: EventError[] }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] };

function flattenIssues(error: z.ZodError): { path: (string | number)[]; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    message: issue.message,
  }));
}

/**
 * Whether any string inside a JSON value holds a NUL character, which PostgreSQL can't store in text. Walks with its
 * own stack, so a deeply nested value can't overflow the call stack.
 */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (next.includes('\0')) return true;
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (typeof next === 'object' && next !== null) {
      for (const key in next) {
        if (key.includes('\0')) return true;
        pending.push((next as Record<string, unknown>)[key]);
      }
    }
  }
  return false;
}

/**
 * Validates a batch the way the collector's ingest route does: an invalid envelope rejects the whole batch,
 * while an invalid event (or one breaking the privacy rule) drops only that event.
 */
export function parseBatch(input: unknown): ParseBatchResult {
  const envelope = BatchEnvelope.safeParse(input);
  if (!envelope.success) return { ok: false, issues: flattenIssues(envelope.error) };
  const { events: _, ...header } = envelope.data;
  if (containsNul(header)) return { ok: false, issues: [{ path: [], message: 'NUL characters are not allowed' }] };

  const { events: raw, ...rest } = envelope.data;
  const events: Event[] = [];
  const errors: EventError[] = [];
  raw.forEach((candidate, index) => {
    const parsed = Event.safeParse(candidate);
    if (parsed.success && containsNul(parsed.data)) {
      errors.push({
        index,
        reason: 'invalid_event',
        issues: [{ path: [], message: 'NUL characters are not allowed' }],
      });
      return;
    }
    if (!parsed.success) {
      errors.push({ index, reason: 'invalid_event', issues: flattenIssues(parsed.error) });
      return;
    }
    const violation = privacyViolation(parsed.data, rest.mode);
    if (violation) {
      errors.push({ index, reason: violation });
      return;
    }
    events.push(parsed.data);
  });
  return { ok: true, envelope: rest, events, errors };
}

/** Major wire versions the current collector accepts (current and previous). */
export const ACCEPTED_WIRE_VERSIONS: readonly number[] = [1];
