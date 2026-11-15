import { describe, expect, it } from 'vitest';
import { EXPORTER_METRICS, type MetricSink, translateEvent, uuidv7, type WireEvent } from '../src/index.js';

function capture() {
  const calls: [string, string, Record<string, string>, number][] = [];
  const sink: MetricSink = {
    add: (m, l, v) => void calls.push(['add', m, { ...l }, v]),
    record: (m, l, v) => void calls.push(['record', m, { ...l }, v]),
    set: (m, l, v) => void calls.push(['set', m, { ...l }, v]),
  };
  return { sink, calls };
}

const ev = (type: string, fields: Record<string, unknown>) =>
  ({ id: uuidv7(), ts: Date.now(), type, ...fields }) as WireEvent;

describe('translateEvent', () => {
  it('counts interactions and records response and handler time in seconds', () => {
    const { sink, calls } = capture();
    translateEvent(
      ev('interaction', {
        kind: 'chat_input',
        command: 'ticket',
        outcome: 'ok',
        ackMs: 250,
        handlerMs: 1200,
        user: '',
      }),
      sink,
    );
    expect(calls).toEqual([
      ['add', 'interactions', { kind: 'chat_input', command: 'ticket', outcome: 'ok' }, 1],
      ['record', 'interaction_response', { kind: 'chat_input', command: 'ticket' }, 0.25],
      ['record', 'interaction_handler', { kind: 'chat_input', command: 'ticket' }, 1.2],
    ]);
  });

  it('counts a failed handler as an interaction error, by class', () => {
    const { sink, calls } = capture();
    translateEvent(
      ev('interaction', { kind: 'chat_input', command: 'roll', outcome: 'error', errorClass: 'RangeError', user: '' }),
      sink,
    );
    expect(calls).toContainEqual(['add', 'interaction_errors', { command: 'roll', error_class: 'RangeError' }, 1]);

    const ok = capture();
    translateEvent(ev('interaction', { kind: 'chat_input', command: 'roll', outcome: 'ok', user: '' }), ok.sink);
    expect(ok.calls.map((c) => c[1])).not.toContain('interaction_errors');
  });

  it('counts message (prefix) commands with interactions, without a response time', () => {
    const { sink, calls } = capture();
    translateEvent(
      ev('message_command', {
        command: 'ban',
        outcome: 'error',
        errorClass: 'TypeError',
        handlerMs: 40,
        user: '',
        guild: '112233445566778899',
      }),
      sink,
    );
    expect(calls).toEqual([
      ['add', 'interactions', { kind: 'message_command', command: 'ban', outcome: 'error' }, 1],
      ['add', 'interaction_errors', { command: 'ban', error_class: 'TypeError' }, 1],
      ['record', 'interaction_handler', { kind: 'message_command', command: 'ban' }, 0.04],
    ]);
  });

  it('labels components with the command that created their message', () => {
    const { sink, calls } = capture();
    translateEvent(ev('interaction', { kind: 'button', sourceCommand: 'poll', outcome: 'no_response' }), sink);
    expect(calls[0]).toEqual(['add', 'interactions', { kind: 'button', command: 'poll', outcome: 'no_response' }, 1]);
  });

  it('expands REST windows into requests by route and the invalid-request budget', () => {
    const { sink, calls } = capture();
    translateEvent(
      ev('rest_window', {
        windowMs: 5000,
        rows: [{ method: 'POST', route: '/channels/:id/messages', status: 403, count: 7, retries: 0, latency: [] }],
        invalid: { count401: 0, count403: 7, count429: 2, shared429: 5 },
      }),
      sink,
    );
    expect(calls).toEqual([
      ['add', 'rest_requests', { method: 'POST', route: '/channels/:id/messages', status: '403' }, 7],
      ['add', 'rest_invalid_requests', { status: '403' }, 7],
      ['add', 'rest_invalid_requests', { status: '429' }, 2],
    ]);
  });

  it('maps gauges, converting milliseconds to seconds, and ignores unknown gauges', () => {
    const { sink, calls } = capture();
    translateEvent(
      ev('gauge_window', {
        gauges: [
          { name: 'shard.ping_ms', shard: 3, value: 42 },
          { name: 'memory.rss_bytes', value: 1000 },
          { name: 'something.new', value: 1 },
        ],
      }),
      sink,
    );
    expect(calls).toEqual([
      ['set', 'shard_ping', { shard: '3' }, 0.042],
      ['set', 'memory', { type: 'rss' }, 1000],
    ]);
  });

  it('never produces a user or server label', () => {
    for (const metric of Object.values(EXPORTER_METRICS)) {
      for (const label of metric.labels) expect(['user', 'guild', 'server', 'actor']).not.toContain(label);
    }
    const { sink, calls } = capture();
    translateEvent(ev('custom', { name: 'ticket_opened', props: {}, user: '', guild: '112233445566778899' }), sink);
    translateEvent(ev('guild_join', { info: { guild: '112233445566778899' }, detectedAtStartup: false }), sink);
    expect(JSON.stringify(calls)).not.toContain('112233445566778899');
  });

  it('ignores event types it does not know', () => {
    const { sink, calls } = capture();
    translateEvent(ev('sdk_health', { queueDepth: 1 }), sink);
    expect(calls).toEqual([]);
  });
});
