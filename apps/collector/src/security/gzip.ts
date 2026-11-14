import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { MAX_DECOMPRESSED_BYTES } from '@shardlens/schema';

const gunzipAsync = promisify(gunzip);

/** Gunzips off the event loop. Rejects with a `RangeError` past `maxBytes` (the gzip-bomb guard). */
export function gunzipBounded(body: Buffer, maxBytes: number = MAX_DECOMPRESSED_BYTES): Promise<Buffer> {
  return gunzipAsync(body, { maxOutputLength: maxBytes });
}
