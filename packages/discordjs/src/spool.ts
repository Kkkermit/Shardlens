import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventSpool, WireEvent } from '@shardlens/core';

const SEGMENT = /^seg-(\d{13})-(\d{6})\.ndjson$/;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Append-only NDJSON segments in one folder, one batch per segment, capped in size (oldest evicted first), readable
 * by the bot's user only. Events arrive hashed and without audit identities.
 */
export class FileSpool implements EventSpool {
  readonly #dir: string;
  readonly #maxBytes: number;
  #ready: Promise<void> | undefined;
  /** Bytes on disk, computed on first use and kept up to date. */
  #bytes: number | undefined;
  /**
   * Starts at random: processes sharing a folder (sharded bots) often spill in the same millisecond on shutdown, and a
   * repeated name would replace another process's segment.
   */
  #seq = Math.floor(Math.random() * 1_000_000);

  constructor(dir: string, maxBytes = DEFAULT_MAX_BYTES) {
    this.#dir = dir;
    this.#maxBytes = Number.isFinite(maxBytes) ? Math.max(1024, maxBytes) : DEFAULT_MAX_BYTES;
  }

  async write(events: readonly WireEvent[]): Promise<boolean> {
    if (events.length === 0) return true;
    await this.#init();
    const body = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    const size = Buffer.byteLength(body);
    if (size > this.#maxBytes) return false;
    let bytes = await this.#size();
    // Make room by evicting the oldest batches: recent data matters most once the collector is back.
    for (const name of await this.#segments()) {
      if (bytes + size <= this.#maxBytes) break;
      const path = join(this.#dir, name);
      const old = await stat(path).catch(() => undefined);
      await unlink(path).catch(() => undefined);
      bytes -= old?.size ?? 0;
    }
    const name = `seg-${String(Date.now()).padStart(13, '0')}-${String(this.#seq++ % 1_000_000).padStart(6, '0')}.ndjson`;
    const temp = join(this.#dir, `${name}.tmp`);
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, join(this.#dir, name));
    this.#bytes = bytes + size;
    return true;
  }

  async next(): Promise<{ id: string; events: WireEvent[] } | undefined> {
    await this.#init();
    for (const name of await this.#segments()) {
      const text = await readFile(join(this.#dir, name), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const events: WireEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as WireEvent);
        } catch {
          // A torn write leaves at most a partial last line: skip it.
        }
      }
      if (events.length > 0) return { id: name, events };
      await this.ack(name);
    }
    return undefined;
  }

  async ack(id: string): Promise<void> {
    if (!SEGMENT.test(id)) return; // only our own file names: never a path from anywhere else
    const path = join(this.#dir, id);
    const size = (await stat(path).catch(() => undefined))?.size ?? 0;
    await unlink(path).catch(() => undefined);
    if (this.#bytes !== undefined) this.#bytes = Math.max(0, this.#bytes - size);
  }

  #init(): Promise<void> {
    this.#ready ??= mkdir(this.#dir, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.#ready;
  }

  async #segments(): Promise<string[]> {
    return (await readdir(this.#dir)).filter((n) => SEGMENT.test(n)).sort();
  }

  async #size(): Promise<number> {
    if (this.#bytes === undefined) {
      let total = 0;
      for (const name of await this.#segments())
        total += (await stat(join(this.#dir, name)).catch(() => undefined))?.size ?? 0;
      this.#bytes = total;
    }
    return this.#bytes;
  }
}
