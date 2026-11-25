import { type Document, MaxKey, MinKey } from 'mongodb';
import type { QueryAnswer } from '../../store.js';
import type { Mongo } from '../connect.js';

type SdkInstance = QueryAnswer<'reliability'>['sdkInstances'][number];

/** The bot processes that reported on themselves, the 50 latest first. */
export async function sdkInstances(m: Mongo, appId: string): Promise<SdkInstance[]> {
  const docs = await m.c.sdkHealth
    .find({ _id: { $gte: { appId, instance: new MinKey() }, $lte: { appId, instance: new MaxKey() } } } as Document)
    .sort({ ts: -1 })
    .limit(50)
    .toArray();
  return docs.map((h) => ({
    instance: h._id.instance,
    ts: h.ts,
    shards: h.shards,
    queueDepth: h.queueDepth,
    dropped: h.dropped,
    failedFlushes: h.failedFlushes,
    internalErrors: h.internalErrors,
    sdkVersion: h.sdkVersion ?? null,
  }));
}
