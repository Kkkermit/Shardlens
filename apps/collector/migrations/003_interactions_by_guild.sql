-- Split the server dimension out of the `interactions` rollups. Before this, `interactions` dims
-- included the guild, so the rollup tables grew with commands × servers × locales. From now on:
--   interactions            kind, command, sub, outcome, context, install, locale, tier (no server)
--   interactions.by_guild   kind, command, outcome, guild
-- Existing rollups are converted in place, so history stays complete.

CREATE TEMP TABLE split_by_guild (LIKE rollup_1h) ON COMMIT DROP;
CREATE TEMP TABLE split_no_guild (LIKE rollup_1h) ON COMMIT DROP;

-- rollup_1m
INSERT INTO split_by_guild (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, 'interactions.by_guild', sha256(convert_to(d::text, 'UTF8')), d,
       sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
  FROM (SELECT r.*, jsonb_build_object('kind', dims->'kind', 'command', dims->'command', 'outcome', dims->'outcome',
                                      'guild', dims->'guild') AS d
          FROM rollup_1m r WHERE metric = 'interactions' AND dims->>'guild' IS NOT NULL) s
 GROUP BY app_id, bucket, d;
INSERT INTO split_no_guild (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, metric, sha256(convert_to((dims - 'guild')::text, 'UTF8')), dims - 'guild',
       sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
  FROM rollup_1m WHERE metric = 'interactions' AND dims ? 'guild'
 GROUP BY app_id, bucket, metric, dims - 'guild';
DELETE FROM rollup_1m WHERE metric = 'interactions' AND dims ? 'guild';
INSERT INTO rollup_1m SELECT * FROM split_no_guild ON CONFLICT DO NOTHING;
INSERT INTO rollup_1m SELECT * FROM split_by_guild ON CONFLICT DO NOTHING;
TRUNCATE split_by_guild, split_no_guild;

-- rollup_1h
INSERT INTO split_by_guild (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, 'interactions.by_guild', sha256(convert_to(d::text, 'UTF8')), d,
       sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
  FROM (SELECT r.*, jsonb_build_object('kind', dims->'kind', 'command', dims->'command', 'outcome', dims->'outcome',
                                      'guild', dims->'guild') AS d
          FROM rollup_1h r WHERE metric = 'interactions' AND dims->>'guild' IS NOT NULL) s
 GROUP BY app_id, bucket, d;
INSERT INTO split_no_guild (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, metric, sha256(convert_to((dims - 'guild')::text, 'UTF8')), dims - 'guild',
       sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
  FROM rollup_1h WHERE metric = 'interactions' AND dims ? 'guild'
 GROUP BY app_id, bucket, metric, dims - 'guild';
DELETE FROM rollup_1h WHERE metric = 'interactions' AND dims ? 'guild';
INSERT INTO rollup_1h SELECT * FROM split_no_guild ON CONFLICT DO NOTHING;
INSERT INTO rollup_1h SELECT * FROM split_by_guild ON CONFLICT DO NOTHING;
TRUNCATE split_by_guild, split_no_guild;

-- rollup_1d
INSERT INTO split_by_guild (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, 'interactions.by_guild', sha256(convert_to(d::text, 'UTF8')), d,
       sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
  FROM (SELECT r.*, jsonb_build_object('kind', dims->'kind', 'command', dims->'command', 'outcome', dims->'outcome',
                                      'guild', dims->'guild') AS d
          FROM rollup_1d r WHERE metric = 'interactions' AND dims->>'guild' IS NOT NULL) s
 GROUP BY app_id, bucket, d;
INSERT INTO split_no_guild (app_id, bucket, metric, dims_hash, dims, count, sum, min, max, hist)
SELECT app_id, bucket, metric, sha256(convert_to((dims - 'guild')::text, 'UTF8')), dims - 'guild',
       sum(count), sum(sum), min(min), max(max), shardlens_hist_sum(hist)
  FROM rollup_1d WHERE metric = 'interactions' AND dims ? 'guild'
 GROUP BY app_id, bucket, metric, dims - 'guild';
DELETE FROM rollup_1d WHERE metric = 'interactions' AND dims ? 'guild';
INSERT INTO rollup_1d SELECT * FROM split_no_guild ON CONFLICT DO NOTHING;
INSERT INTO rollup_1d SELECT * FROM split_by_guild ON CONFLICT DO NOTHING;

-- Funnels and the cohort builder read raw custom events and interactions by user hash within a time range.
CREATE INDEX IF NOT EXISTS custom_events_app_ts ON custom_events (app_id, ts);
