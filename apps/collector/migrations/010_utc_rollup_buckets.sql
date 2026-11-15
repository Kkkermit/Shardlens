-- Collectors before 1.1 cut hourly and daily rollups in the database server's time zone. They now always cut them in
-- UTC, so on a server set to another zone the upgrade left both kinds of bucket side by side, and the hours and days
-- around the upgrade were counted twice. On a UTC server this finds nothing to do.
SET LOCAL TIME ZONE 'UTC';

-- Hours still covered by minute rollups (kept 14 days) are rebuilt from them: every UTC hour a misaligned row
-- overlaps is deleted, misaligned rows included, and recomputed.
CREATE TEMP TABLE realign_hours ON COMMIT DROP AS
  SELECT DISTINCT h.start
    FROM rollup_1h r,
         LATERAL (VALUES (date_trunc('hour', r.bucket)), (date_trunc('hour', r.bucket) + interval '1 hour')) AS h(start)
   WHERE r.bucket <> date_trunc('hour', r.bucket) AND r.bucket >= date_trunc('day', now()) - interval '13 days';
DELETE FROM rollup_1h r USING realign_hours t WHERE r.bucket >= t.start AND r.bucket < t.start + interval '1 hour';
INSERT INTO rollup_1h (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT m.app_id, date_trunc('hour', m.bucket), m.metric, m.dims_hash, (array_agg(m.dims))[1],
       sum(m.count), sum(m.sum), min(m.min), max(m.max), shardlens_hist_sum(m.hist)
  FROM rollup_1m m JOIN realign_hours t ON m.bucket >= t.start AND m.bucket < t.start + interval '1 hour'
 GROUP BY m.app_id, date_trunc('hour', m.bucket), m.metric, m.dims_hash;

-- Older hours have nothing finer left: each moves to the UTC hour holding most of it and is added to what is there.
CREATE TEMP TABLE realigned_rows ON COMMIT DROP AS
  SELECT app_id, date_trunc('hour', bucket + interval '30 minutes') AS bucket, metric, dims_hash,
         (array_agg(dims))[1] AS dims, sum(count) AS count, sum(sum) AS sum, min(min) AS min, max(max) AS max,
         shardlens_hist_sum(hist) AS hist
    FROM rollup_1h WHERE bucket <> date_trunc('hour', bucket)
   GROUP BY app_id, date_trunc('hour', bucket + interval '30 minutes'), metric, dims_hash;
DELETE FROM rollup_1h WHERE bucket <> date_trunc('hour', bucket);
INSERT INTO rollup_1h (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist FROM realigned_rows
ON CONFLICT (app_id, metric, dims_hash, bucket) DO UPDATE
  SET count = rollup_1h.count + EXCLUDED.count, sum = rollup_1h.sum + EXCLUDED.sum,
      min = least(rollup_1h.min, EXCLUDED.min), max = greatest(rollup_1h.max, EXCLUDED.max),
      hist = shardlens_array_add(rollup_1h.hist, EXCLUDED.hist);
DROP TABLE realigned_rows;

-- Days still covered by hourly rollups (kept 13 months), now all on UTC hours, are rebuilt from them.
CREATE TEMP TABLE realign_days ON COMMIT DROP AS
  SELECT DISTINCT d.start
    FROM rollup_1d r,
         LATERAL (VALUES (date_trunc('day', r.bucket)), (date_trunc('day', r.bucket) + interval '1 day')) AS d(start)
   WHERE r.bucket <> date_trunc('day', r.bucket)
     AND r.bucket >= date_trunc('day', now() - interval '13 months') + interval '1 day';
DELETE FROM rollup_1d r USING realign_days t WHERE r.bucket >= t.start AND r.bucket < t.start + interval '1 day';
INSERT INTO rollup_1d (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT h.app_id, date_trunc('day', h.bucket), h.metric, h.dims_hash, (array_agg(h.dims))[1],
       sum(h.count), sum(h.sum), min(h.min), max(h.max), shardlens_hist_sum(h.hist)
  FROM rollup_1h h JOIN realign_days t ON h.bucket >= t.start AND h.bucket < t.start + interval '1 day'
 GROUP BY h.app_id, date_trunc('day', h.bucket), h.metric, h.dims_hash;

-- Older days move to the UTC day holding most of them.
CREATE TEMP TABLE realigned_rows ON COMMIT DROP AS
  SELECT app_id, date_trunc('day', bucket + interval '12 hours') AS bucket, metric, dims_hash,
         (array_agg(dims))[1] AS dims, sum(count) AS count, sum(sum) AS sum, min(min) AS min, max(max) AS max,
         shardlens_hist_sum(hist) AS hist
    FROM rollup_1d WHERE bucket <> date_trunc('day', bucket)
   GROUP BY app_id, date_trunc('day', bucket + interval '12 hours'), metric, dims_hash;
DELETE FROM rollup_1d WHERE bucket <> date_trunc('day', bucket);
INSERT INTO rollup_1d (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist FROM realigned_rows
ON CONFLICT (app_id, metric, dims_hash, bucket) DO UPDATE
  SET count = rollup_1d.count + EXCLUDED.count, sum = rollup_1d.sum + EXCLUDED.sum,
      min = least(rollup_1d.min, EXCLUDED.min), max = greatest(rollup_1d.max, EXCLUDED.max),
      hist = shardlens_array_add(rollup_1d.hist, EXCLUDED.hist);
