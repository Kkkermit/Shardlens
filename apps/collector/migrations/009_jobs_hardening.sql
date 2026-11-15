-- Histogram buckets are int4. Adding two that pass 2^31 raised "integer out of range" and stopped the rollup job for
-- every app; a full bucket now stays at the maximum instead.
CREATE OR REPLACE FUNCTION shardlens_array_add(a integer[], b integer[]) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a ELSE
    ARRAY(SELECT least(coalesce(x, 0)::bigint + coalesce(y, 0), 2147483647)::integer
          FROM unnest(a, b) WITH ORDINALITY AS t(x, y, i) ORDER BY i) END
$$;

-- Collectors starting together on an empty database each created the same partitions, and all but one crashed with
-- "already exists". The lock lasts until the caller's transaction ends.
CREATE OR REPLACE FUNCTION shardlens_ensure_daily_partitions(parents text[], from_day date, to_day date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  p text;
  d date;
  created integer := 0;
  part text;
BEGIN
  PERFORM pg_advisory_xact_lock(7241865326);
  FOREACH p IN ARRAY parents LOOP
    d := from_day;
    WHILE d <= to_day LOOP
      part := format('%s_%s', p, to_char(d, 'YYYYMMDD'));
      IF to_regclass(part) IS NULL THEN
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       part, p, to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00', to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00');
        created := created + 1;
      END IF;
      d := d + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END
$$;
