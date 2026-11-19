import { ShardlensClientError } from './errors.js';
import type { LiveUpdate } from './results.js';
import type { OpenStream, Transport } from './transport.js';

/**
 * The collector sends a heartbeat every 15 seconds, whatever its database does. Three missed in a row mean the
 * connection is gone without either end closing it, which otherwise leaves a reader waiting for ever.
 */
const LIVE_QUIET_MS = 45_000;

interface ServerSentEvent {
  /** The stream's `event` field; `message` when it gave none. */
  event: string;
  data: string;
}

/** A line ends with LF, CR or CRLF. A CR that ends the buffer waits for the next chunk: its LF may follow. */
const LINE_END = /\r\n|\n|\r(?!$)/;

/**
 * Reads Server-Sent Events off a byte stream, framed as the HTML standard says: a blank line ends an event, a line
 * that starts with a colon is a comment (a heartbeat), and an event cut short by the end of the stream is dropped.
 * Events may arrive split across chunks at any byte.
 */
export async function* serverSentEvents(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return;
    buffer += decoder.decode(chunk.value, { stream: true });
    for (let end = LINE_END.exec(buffer); end; end = LINE_END.exec(buffer)) {
      const line = buffer.slice(0, end.index);
      buffer = buffer.slice(end.index + end[0].length);
      if (line === '') {
        if (data.length > 0) yield { event: event || 'message', data: data.join('\n') };
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
  }
}

function parseUpdate(data: string): LiveUpdate | undefined {
  try {
    return JSON.parse(data) as LiveUpdate;
  } catch {
    return undefined;
  }
}

/**
 * The collector's live stream (`GET /v1/live`) as an async iterable. The request is made when iteration starts, and
 * the connection is closed when it ends, however it ends: the signal, leaving the loop, or the collector.
 */
export async function* liveUpdates(
  transport: Transport,
  signal: AbortSignal | undefined,
): AsyncGenerator<LiveUpdate, void, undefined> {
  if (signal?.aborted) return;
  let stream: OpenStream;
  try {
    stream = await transport.open('/v1/live', signal);
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  }
  const reader = stream.body.getReader();
  // Cancelling ends a read that is waiting, whether or not this `fetch` ties the body to its signal.
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let quiet = false;
  // Timed only while a read waits: a reader busy with an update leaves the next ones in the stream's buffer.
  const watched = {
    async read() {
      const timer = setTimeout(() => {
        quiet = true;
        cancel();
      }, LIVE_QUIET_MS);
      try {
        return await reader.read();
      } finally {
        clearTimeout(timer);
      }
    },
  };
  try {
    for await (const event of serverSentEvents(watched)) {
      // The other event the collector sends, `error`, marks a second it had no numbers for: the next one follows.
      if (event.event !== 'tiles') continue;
      const update = parseUpdate(event.data);
      if (update) yield update;
    }
  } catch (error) {
    if (signal?.aborted) return;
    if (!quiet) throw transport.unreachable(error);
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    stream.close();
  }
  if (quiet && !signal?.aborted) {
    throw new ShardlensClientError(
      `The collector's live stream sent nothing for ${LIVE_QUIET_MS / 1000} seconds: the connection is gone.`,
      { status: 0, code: 'timeout' },
    );
  }
}
