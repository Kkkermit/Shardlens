import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventSpool, WireEvent } from '@shardlens/core';

/**
 * `seg-<ms>-<seq>-<bytes>.ndjson`. The size is in the name so one directory listing gives the folder's real size: the
 * shards of a bot often share a folder, and each writes and deletes segments. Earlier versions left the size out.
 */
const SEGMENT = /^seg-(\d{13})-(\d{6})(?:-(\d{1,12}))?\.ndjson$/;
const TEMP = /^seg-\d{13}-\d{6}(?:-\d{1,12})?\.ndjson\.tmp$/;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
/** A temp file older than this was left by a failed write or a crash; a newer one may still be being written. */
const STALE_TEMP_MS = 60_000;

interface Segment {
  name: string;
  size: number;
}

/**
 * Append-only NDJSON segments in one folder, one batch per segment, capped in size (oldest evicted first), readable
 * by the bot's user only. Events arrive hashed and without audit identities. Several processes may share the folder.
 */
export class FileSpool implements EventSpool {
  readonly #dir: string;
  readonly #maxBytes: number;
  #ready: Promise<void> | undefined;
  /**
   * Starts at random: processes sharing a folder (sharded bots) often spill in the same millisecond on shutdown, and a
   * repeated name would replace another process's segment.
   */
  #seq = Math.floor(Math.random() * 1_000_000);
  /** Segments the collector accepted that couldn't be deleted (a read-only volume): never handed out again. */
  readonly #acked = new Set<string>();
  readonly #onEvict: ((events: number) => void) | undefined;

  /** `onEvict` hears how many unsent events each batch evicted at the size cap held: they are lost. */
  constructor(dir: string, maxBytes = DEFAULT_MAX_BYTES, onEvict?: (events: number) => void) {
    this.#dir = dir;
    this.#maxBytes = Number.isFinite(maxBytes) ? Math.max(1024, maxBytes) : DEFAULT_MAX_BYTES;
    this.#onEvict = onEvict;
  }

  async write(events: readonly WireEvent[]): Promise<boolean> {
    if (events.length === 0) return true;
    await this.#init();
    const body = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    const size = Buffer.byteLength(body);
    if (size > this.#maxBytes) return false;
    const segments = await this.#segments();
    let bytes = segments.reduce((n, segment) => n + segment.size, 0);
    // Make room by evicting the oldest batches: recent data matters most once the collector is back.
    for (const segment of segments) {
      if (bytes + size <= this.#maxBytes) break;
      const path = join(this.#dir, segment.name);
      // Read before deleting, to count what is lost. Not a batch the collector already has.
      const text = this.#acked.has(segment.name) ? undefined : await readFile(path, 'utf8').catch(() => undefined);
      const outcome = await unlink(path).then(
        () => 'evicted' as const,
        // ENOENT: another process replayed or evicted it first.
        (error: unknown) => ((error as { code?: unknown }).code === 'ENOENT' ? ('gone' as const) : ('kept' as const)),
      );
      if (outcome !== 'kept') bytes -= segment.size;
      if (outcome === 'evicted' && text !== undefined) this.#onEvict?.(parse(text).length);
    }
    if (bytes + size > this.#maxBytes) return false;
    const ms = String(Date.now()).padStart(13, '0');
    await this.#put(`seg-${ms}-${String(this.#seq++ % 1_000_000).padStart(6, '0')}-${size}.ndjson`, body);
    return true;
  }

  async next(): Promise<{ id: string; events: WireEvent[] } | undefined> {
    await this.#init();
    for (const { name } of await this.#segments()) {
      if (this.#acked.has(name)) continue;
      const text = await readFile(join(this.#dir, name), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const events = parse(text);
      if (events.length > 0) return { id: name, events };
      await this.ack(name).catch(() => undefined);
    }
    return undefined;
  }

  /** Deletes an accepted segment. Throws if it can't, but the segment is never handed out again by this process. */
  async ack(id: string): Promise<void> {
    if (!SEGMENT.test(id)) return; // only our own file names: never a path from anywhere else
    this.#acked.add(id);
    await unlink(join(this.#dir, id)).catch((error: unknown) => {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error; // ENOENT: replayed by another process
    });
    this.#acked.delete(id);
  }

  /** Removes the events `match` accepts from every segment, such as those of a user who asked for erasure. */
  async drop(match: (event: WireEvent) => boolean): Promise<number> {
    await this.#init();
    let dropped = 0;
    for (const { name } of await this.#segments()) {
      const text = await readFile(join(this.#dir, name), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const events = parse(text);
      const keep = events.filter((event) => !match(event));
      if (keep.length === events.length) continue;
      dropped += events.length - keep.length;
      if (keep.length > 0) {
        // Same time and sequence, so it keeps its place in the replay order; the size in the name changes.
        const body = `${keep.map((e) => JSON.stringify(e)).join('\n')}\n`;
        const [, ms, seq] = SEGMENT.exec(name) as RegExpExecArray;
        await this.#put(`seg-${ms}-${seq}-${Buffer.byteLength(body)}.ndjson`, body);
      }
      await this.ack(name);
    }
    return dropped;
  }

  /** Writes a segment under a temp name first, so a reader never sees half of one. */
  async #put(name: string, body: string): Promise<void> {
    const temp = join(this.#dir, `${name}.tmp`);
    try {
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, join(this.#dir, name));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  #init(): Promise<void> {
    this.#ready ??= (async () => {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      // Temp files left by a failed write or a crash are never renamed into place, and would only take up space.
      const now = Date.now();
      for (const name of await readdir(this.#dir)) {
        if (!TEMP.test(name)) continue;
        const info = await stat(join(this.#dir, name)).catch(() => undefined);
        if (info && now - info.mtimeMs > STALE_TEMP_MS) await unlink(join(this.#dir, name)).catch(() => undefined);
      }
    })().catch((error: unknown) => {
      this.#ready = undefined; // try again next time, for example once the volume is mounted
      throw error;
    });
    return this.#ready;
  }

  /** Every segment in the folder, oldest first, with its size. */
  async #segments(): Promise<Segment[]> {
    const out: Segment[] = [];
    for (const name of (await readdir(this.#dir)).sort()) {
      const match = SEGMENT.exec(name);
      if (!match) continue;
      const size = match[3] ? Number(match[3]) : (await stat(join(this.#dir, name)).catch(() => undefined))?.size;
      if (size !== undefined) out.push({ name, size });
    }
    return out;
  }
}

function parse(text: string): WireEvent[] {
  const events: WireEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as WireEvent);
    } catch {
      // A torn write leaves at most a partial last line: skip it.
    }
  }
  return events;
}
