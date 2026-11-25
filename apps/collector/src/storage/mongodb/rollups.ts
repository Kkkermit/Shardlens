import type { AnyBulkWriteOperation, Collection } from 'mongodb';
import { type DirtyBucketDoc, dimsKey, type RollupDoc, rollupId } from './collections.js';
import type { Mongo } from './connect.js';
import { type Grain, ROLLUP_SOURCES, type SourceRow, sumHistograms } from './rollup-sources.js';

/*
 * The rollup job on MongoDB, as PostgreSQL's (`postgres/rollups.ts`) gives it: the same windows, metrics, dimensions
 * and figures, UTC buckets. Without transactions or row locks, every write here is a recompute that replaces what it
 * covers: a bucket's documents have deterministic IDs (`rollupId`), are replaced whole, and documents a recompute no
 * longer produces are deleted, so running a window again, after a crash or not, leaves it right.
 *
 * PostgreSQL recomputes the whole hour and day of every window from minutes on the server. Here that would read and
 * rewrite every group of the day each minute, over the network, so hours and days are recomputed only for the groups a
 * window touched (those it wrote or deleted): the rest of the hour or day hasn't changed.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Most late-event history one run recomputes; the rest stays marked for the next run. */
const MAX_DIRTY_SPAN_MS = 6 * HOUR;
/**
 * Ingest marks an event's minute dirty only when it arrives more than 2 minutes late (`LATE_MS` in ingest/write.ts).
 * Anything newer must be inside the next run's recent window, however long after its arrival that run starts.
 */
const NOT_MARKED_MS = 2 * MINUTE;
/** Every run recomputes at least this much recent history, whether or not anything was marked. */
const RECENT_MS = 5 * MINUTE;
/** A recent window never reaches further back than this; older history relies on dirty marks. */
const MAX_RECENT_MS = HOUR;
/** Minute rollups are kept 14 days; whole days from this many days back are certain to have all of theirs. */
const MINUTE_RETENTION_DAYS = 13;
/** Most single-event history one recompute reads at once, by grain: a backfill goes through its range in pieces. */
const CHUNK_MS: Record<Grain, number> = { minute: 6 * HOUR, hour: 7 * DAY, day: 31 * DAY };
/** Histogram buckets are int4 on PostgreSQL, which keeps a full one at the maximum. */
const INT4_MAX = 2_147_483_647;
/** The `appId` of a minute a run has started on (`DirtyBucketDoc`). */
const RUN_MARK = '';

const floorTo = (ms: number, step: number) => Math.floor(ms / step) * step;
const span = (from: number, to: number) => `${new Date(from).toISOString()}–${new Date(to).toISOString()}`;

/** A rollup document's identity: what a recompute touched. `bucket` in epoch ms. */
interface Key {
  appId: string;
  metric: string;
  dimsKey: string;
  bucket: number;
}
const keyString = (k: Key) => `${k.appId}\0${k.metric}\0${k.bucket}\0${k.dimsKey}`;
const keyOf = (d: Pick<RollupDoc, 'appId' | 'metric' | 'dimsKey' | 'bucket'>): Key => ({
  appId: d.appId,
  metric: d.metric,
  dimsKey: d.dimsKey,
  bucket: d.bucket.getTime(),
});

/** Statements that failed on their data, as `what grain from–to`. */
type Skipped = string[];

/** An app, and where its single events are complete from: they are kept for its raw retention. */
interface AppRetention {
  appId: string;
  rawFloor: number;
}

function grainCollection(m: Mongo, grain: Grain): Collection<RollupDoc> {
  return grain === 'minute' ? m.c.rollup1m : grain === 'hour' ? m.c.rollup1h : m.c.rollup1d;
}

const finite = (d: RollupDoc) => [d.count, d.sum, d.min ?? 0, d.max ?? 0].every(Number.isFinite);

/** A histogram as stored: whole numbers (a sum may come back as a 64-bit integer), each at most `INT4_MAX`. */
const histogram = (h: readonly unknown[]) => h.map((x) => Math.min(Number(x), INT4_MAX));

function rollupDoc(
  appId: string,
  metric: string,
  bucket: Date,
  dims: RollupDoc['dims'],
  figures: { count: number; sum: number; min: number | null; max: number | null; hist: number[] | null },
): RollupDoc {
  const key = dimsKey(dims);
  const doc: RollupDoc = {
    _id: rollupId(appId, metric, bucket, key),
    appId,
    metric,
    bucket,
    dims,
    dimsKey: key,
    count: Number(figures.count),
    sum: Number(figures.sum),
  };
  if (figures.min != null) doc.min = Number(figures.min);
  if (figures.max != null) doc.max = Number(figures.max);
  if (figures.hist) doc.hist = histogram(figures.hist);
  return doc;
}

/** A source's groups as rollup documents: latency sources return one group per latency bucket, added up here. */
function fold(rows: readonly SourceRow[]): RollupDoc[] {
  const groups = new Map<
    string,
    { r: SourceRow; count: number; sum: number; min: number | null; max: number | null; hist: number[] | null }
  >();
  for (const r of rows) {
    const key = `${r._id.a}\0${r._id.m}\0${r._id.t.getTime()}\0${dimsKey(r._id.d)}`;
    let g = groups.get(key);
    if (!g) {
      g = { r, count: 0, sum: 0, min: null, max: null, hist: null };
      groups.set(key, g);
    }
    g.count += Number(r.count);
    g.sum += Number(r.sum);
    if (r.min != null) g.min = g.min === null ? Number(r.min) : Math.min(g.min, Number(r.min));
    if (r.max != null) g.max = g.max === null ? Number(r.max) : Math.max(g.max, Number(r.max));
    if (r._id.b != null) {
      g.hist ??= new Array<number>(40).fill(0);
      g.hist[r._id.b] = (g.hist[r._id.b] ?? 0) + Number(r.hw ?? 0);
    }
    if (r.hist) g.hist = r.hist.map(Number);
  }
  return [...groups.values()].map((g) => rollupDoc(g.r._id.a, g.r._id.m, g.r._id.t, g.r._id.d, g));
}

/**
 * Recomputes every metric's `grain` buckets in [from, to) for these apps from single events: their documents are
 * replaced, and those no longer produced deleted. A metric whose figures overflow is skipped and listed, as
 * PostgreSQL skips a statement that fails on its data. Returns the documents touched, for the cascade.
 */
async function rollupFromRaw(
  m: Mongo,
  grain: Grain,
  apps: string[],
  from: Date,
  to: Date,
  skipped: Skipped,
): Promise<Key[]> {
  const produced = new Map<string, RollupDoc>();
  const metrics: (string | RegExp)[] = [];
  for (const source of ROLLUP_SOURCES) {
    const rows = await source
      .from(m.c)
      .aggregate<SourceRow>(source.pipeline(apps, from, to, grain))
      .toArray();
    const docs = fold(rows);
    if (!docs.every(finite)) {
      skipped.push(`${source.name} by ${grain} ${span(from.getTime(), to.getTime())}`);
      continue;
    }
    metrics.push(...source.metrics);
    for (const doc of docs) produced.set(keyString(keyOf(doc)), doc);
  }
  if (metrics.length === 0) return [];
  const into = grainCollection(m, grain);
  const stored = await into
    .find(
      { appId: { $in: apps }, metric: { $in: metrics }, bucket: { $gte: from, $lt: to } },
      { projection: { appId: 1, metric: 1, dimsKey: 1, bucket: 1 } },
    )
    .toArray();
  const touched = new Map<string, Key>();
  const ops: AnyBulkWriteOperation<RollupDoc>[] = [];
  for (const [key, doc] of produced) {
    touched.set(key, keyOf(doc));
    ops.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
  }
  for (const doc of stored) {
    const key = keyString(keyOf(doc));
    if (produced.has(key)) continue;
    touched.set(key, keyOf(doc));
    ops.push({ deleteOne: { filter: { _id: doc._id } } });
  }
  if (ops.length > 0) await into.bulkWrite(ops, { ordered: false });
  return [...touched.values()];
}

/**
 * Recomputes the hours (from minutes) or days (from hours) holding the touched documents, for the touched groups
 * only: replaced from what the finer grain now holds, or deleted when it holds nothing. Buckets before `floor` are
 * left alone (they are recomputed from single events). Returns the documents touched at this grain.
 */
async function cascade(
  m: Mongo,
  grain: 'hour' | 'day',
  finer: readonly Key[],
  floor: number,
  skipped: Skipped,
): Promise<Key[]> {
  const step = grain === 'hour' ? HOUR : DAY;
  const touched = new Map<string, Key>();
  for (const k of finer) {
    const bucket = floorTo(k.bucket, step);
    if (bucket < floor) continue;
    const key = { ...k, bucket };
    touched.set(keyString(key), key);
  }
  if (touched.size === 0) return [];
  const keys = [...touched.values()];
  const from = Math.min(...keys.map((k) => k.bucket));
  const to = Math.max(...keys.map((k) => k.bucket)) + step;
  const source = grain === 'hour' ? m.c.rollup1m : m.c.rollup1h;
  const rows = await source
    .aggregate<{
      _id: { a: string; m: string; k: string; t: Date };
      dims: RollupDoc['dims'];
      count: number;
      sum: number;
      min: number | null;
      max: number | null;
      hist: number[] | null;
    }>([
      {
        $match: {
          appId: { $in: [...new Set(keys.map((k) => k.appId))] },
          metric: { $in: [...new Set(keys.map((k) => k.metric))] },
          dimsKey: { $in: [...new Set(keys.map((k) => k.dimsKey))] },
          bucket: { $gte: new Date(from), $lt: new Date(to) },
        },
      },
      {
        $group: {
          _id: { a: '$appId', m: '$metric', k: '$dimsKey', t: { $dateTrunc: { date: '$bucket', unit: grain } } },
          dims: { $first: '$dims' },
          count: { $sum: '$count' },
          sum: { $sum: '$sum' },
          min: { $min: '$min' },
          max: { $max: '$max' },
          hists: { $push: '$hist' },
        },
      },
      { $project: { dims: 1, count: 1, sum: 1, min: 1, max: 1, hist: sumHistograms('$hists') } },
    ])
    .toArray();
  const recomputed = new Map<string, RollupDoc>();
  for (const r of rows) {
    const key = keyString({ appId: r._id.a, metric: r._id.m, dimsKey: r._id.k, bucket: r._id.t.getTime() });
    if (touched.has(key)) recomputed.set(key, rollupDoc(r._id.a, r._id.m, r._id.t, r.dims, r));
  }
  if (![...recomputed.values()].every(finite)) {
    skipped.push(`${grain === 'hour' ? 'minutes into hours' : 'hours into days'} ${span(from, to)}`);
    return [];
  }
  const ops: AnyBulkWriteOperation<RollupDoc>[] = keys.map((k) => {
    const doc = recomputed.get(keyString(k));
    if (doc) return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } };
    return { deleteOne: { filter: { _id: rollupId(k.appId, k.metric, new Date(k.bucket), k.dimsKey) } } };
  });
  await grainCollection(m, grain).bulkWrite(ops, { ordered: false });
  return keys;
}

/** The apps by where a recompute from `from` may start for each: never before its single events are complete. */
function byStart(apps: readonly AppRetention[], from: number): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const app of apps) {
    const start = Math.max(from, app.rawFloor);
    groups.set(start, [...(groups.get(start) ?? []), app.appId]);
  }
  return groups;
}

async function appRetention(m: Mongo, now: Date): Promise<AppRetention[]> {
  const today = floorTo(now.getTime(), DAY);
  const apps = await m.c.apps.find({}, { projection: { rawRetentionDays: 1 } }).toArray();
  return apps.map((a) => ({ appId: a._id, rawFloor: today - (a.rawRetentionDays - 1) * DAY }));
}

/**
 * Recomputes rollups for [from, to): minutes for the last 14 days (and the hours and days holding them), and hours
 * and days from single events for older periods while those are kept. A period older than an app's raw retention is
 * left alone, so a recompute never shrinks a rollup.
 */
async function recompute(
  m: Mongo,
  from: number,
  to: number,
  now: Date,
  apps: readonly AppRetention[],
  skipped: Skipped,
): Promise<void> {
  const minuteFloor = floorTo(now.getTime(), DAY) - MINUTE_RETENTION_DAYS * DAY;
  if (to > minuteFloor) {
    for (const [start, ids] of byStart(apps, Math.max(from, minuteFloor))) {
      for (let lo = start; lo < to; lo += CHUNK_MS.minute) {
        const hi = Math.min(to, lo + CHUNK_MS.minute);
        const minutes = await rollupFromRaw(m, 'minute', ids, new Date(lo), new Date(hi), skipped);
        const hours = await cascade(m, 'hour', minutes, minuteFloor, skipped);
        await cascade(m, 'day', hours, minuteFloor, skipped);
      }
    }
  }
  for (const grain of ['hour', 'day'] as const) {
    const step = grain === 'hour' ? HOUR : DAY;
    const start = floorTo(from, step);
    const end = Math.min(floorTo(to - 1, step) + step, minuteFloor);
    if (start >= minuteFloor) continue;
    for (const [lo0, ids] of byStart(apps, start)) {
      for (let lo = lo0; lo < end; lo += CHUNK_MS[grain]) {
        await rollupFromRaw(m, grain, ids, new Date(lo), new Date(Math.min(end, lo + CHUNK_MS[grain])), skipped);
      }
    }
  }
}

export async function backfillRollups(m: Mongo, from: Date, to: Date, now = new Date()): Promise<void> {
  await recompute(m, from.getTime(), to.getTime(), now, await appRetention(m, now), []);
}

function mergeWindows(windows: [number, number][]): [number, number][] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/**
 * The every-minute rollup run: recent minutes plus minutes marked dirty by late events (merged into ranges and capped
 * per run), then the hours and days they belong to, so hourly and daily charts are at most a minute behind.
 *
 * The recent window reaches back to before the previous run started (`since`), less the age at which ingest starts
 * marking events late, so an event that wasn't marked is always inside some run's window, even when runs fall behind.
 * Marks stay until the run that recomputed their minutes finishes, and the run marks its own recent minutes too: a run
 * that fails or dies leaves them for the next. A mark raised again by a late event while the run works (`n`) stays.
 */
export async function runRollups(
  m: Mongo,
  now = new Date(),
  opts: { since?: Date | undefined } = {},
): Promise<{ windows: number; skipped: string[] }> {
  const { c } = m;
  const end = floorTo(now.getTime(), MINUTE) + MINUTE;
  const sinceFrom = opts.since ? floorTo(opts.since.getTime() - NOT_MARKED_MS, MINUTE) : end;
  const recentFrom = Math.max(end - MAX_RECENT_MS, Math.min(end - RECENT_MS, sinceFrom));
  const apps = await appRetention(m, now);
  // The oldest marked minutes first, as many as one run takes, whichever apps marked them.
  const limit = MAX_DIRTY_SPAN_MS / MINUTE;
  const marks = await c.dirtyBuckets
    .find({ '_id.bucket': { $lt: new Date(recentFrom) } })
    .sort({ '_id.bucket': 1 })
    .limit(limit * (apps.length + 1))
    .toArray();
  const buckets = [...new Set(marks.map((d) => d._id.bucket.getTime()))].slice(0, limit);
  const taken = new Set(buckets);
  const claimed = marks.filter((d) => taken.has(d._id.bucket.getTime()));

  const own: DirtyBucketDoc['_id'][] = [];
  for (let b = recentFrom; b < end; b += MINUTE) own.push({ appId: RUN_MARK, bucket: new Date(b) });
  await c.dirtyBuckets.bulkWrite(
    own.map((_id) => ({ updateOne: { filter: { _id }, update: { $setOnInsert: { n: 0 } }, upsert: true } })),
    { ordered: false },
  );

  // Newest first: what the dashboard shows now doesn't wait behind old history.
  const windows = mergeWindows([[recentFrom, end], ...buckets.map((b): [number, number] => [b, b + MINUTE])]).reverse();
  const skipped: Skipped = [];
  for (const [from, to] of windows) await recompute(m, from, to, now, apps, skipped);

  await c.dirtyBuckets.bulkWrite(
    [
      ...claimed.map((d) => ({ deleteOne: { filter: { _id: d._id, n: d.n } } })),
      ...own.map((_id) => ({ deleteOne: { filter: { _id } } })),
    ],
    { ordered: false },
  );
  return { windows: windows.length, skipped };
}
