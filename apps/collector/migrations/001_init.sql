-- Shardlens collector schema v1 (PostgreSQL 16+, no extensions). Spec section 16.1 plus the raw tables M1 needs.
-- Partitions are created ahead of time by the maintenance job (shardlens_ensure_partitions).

CREATE TABLE apps (
  app_id         bigint PRIMARY KEY,
  name           text NOT NULL DEFAULT '',
  mode           text NOT NULL DEFAULT 'privacy' CHECK (mode IN ('privacy', 'audit')),
  salt_period    text NOT NULL DEFAULT 'month' CHECK (salt_period IN ('day', 'week', 'month')),
  timezone       text NOT NULL DEFAULT 'UTC',
  raw_retention_days integer NOT NULL DEFAULT 35 CHECK (raw_retention_days BETWEEN 7 AND 90),
  shard_count    integer,                     -- current shard layout, from guild snapshots
  baseline_done  boolean NOT NULL DEFAULT false, -- first snapshot imports existing servers without counting joins
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id        bigint NOT NULL REFERENCES apps ON DELETE CASCADE,
  scope         text NOT NULL CHECK (scope IN ('ingest', 'read')),
  sha256        bytea NOT NULL UNIQUE,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE salts (
  app_id        bigint NOT NULL REFERENCES apps ON DELETE CASCADE,
  period        text NOT NULL,              -- '2026-11', '2026-W46' or '2026-11-13'
  secret        bytea,                      -- 32 random bytes; NULL once destroyed
  period_end    timestamptz NOT NULL,
  destroy_after timestamptz NOT NULL,       -- period end + 7 days grace
  destroyed_at  timestamptz,
  PRIMARY KEY (app_id, period)
);

-- ---------- raw events (daily partitions, raw_retention_days) ----------

CREATE TABLE interactions (
  id             uuid NOT NULL,
  ts             timestamptz NOT NULL,
  app_id         bigint NOT NULL,
  env            text NOT NULL,
  release        text,
  kind           smallint NOT NULL,          -- 1 chat_input, 2 user_ctx, 3 msg_ctx, 4 entry_point, 5 button, 6 select, 7 modal_submit, 8 autocomplete
  command        text,
  cmd_group      text,
  sub            text,
  command_id     bigint,
  command_scope  smallint,                   -- 0 global, 1 guild
  options        text[] NOT NULL DEFAULT '{}',
  option_values  jsonb,
  custom_id      text,
  component_type smallint,
  source_command text,
  context        smallint,                   -- 0 guild, 1 bot DM, 2 private channel
  install        smallint,                   -- 0 guild, 1 user, 2 both
  guild_id       bigint,
  channel_type   smallint,
  locale         text NOT NULL,
  guild_locale   text,
  member_tier    smallint,                   -- 0 dm, 1 member, 2 manager, 3 admin
  user_hash      bytea NOT NULL,
  salt_period    text NOT NULL,
  premium        boolean NOT NULL,
  outcome        smallint NOT NULL,          -- 0 ok, 1 error, 2 timeout, 3 no_response
  error_code     integer,
  error_class    text,
  ack_ms         integer,
  response_type  smallint,
  deferred       boolean,
  ephemeral      boolean,
  handler_ms     integer,
  shard          smallint,
  weight         real NOT NULL DEFAULT 1,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX interactions_app_ts ON interactions (app_id, ts);
CREATE INDEX interactions_app_cmd_ts ON interactions (app_id, command, ts);
CREATE INDEX interactions_app_guild_ts ON interactions (app_id, guild_id, ts);

CREATE TABLE interaction_errors (
  id             uuid NOT NULL,
  ts             timestamptz NOT NULL,
  app_id         bigint NOT NULL,
  interaction_id uuid NOT NULL,
  command        text,
  error_class    text NOT NULL,
  error_code     integer,
  handler_ms     integer,
  weight         real NOT NULL DEFAULT 1,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE rest_calls (
  event_id   uuid NOT NULL,
  row_no     smallint NOT NULL,
  ts         timestamptz NOT NULL,
  app_id     bigint NOT NULL,
  method     text NOT NULL,
  route      text NOT NULL,               -- bucketed route only, never a raw path
  status     smallint NOT NULL,
  count      integer NOT NULL,
  retries    integer NOT NULL,
  hist       integer[] NOT NULL,
  weight     real NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, row_no, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX rest_calls_app_ts ON rest_calls (app_id, ts);

CREATE TABLE rest_invalid (
  id         uuid NOT NULL,
  ts         timestamptz NOT NULL,
  app_id     bigint NOT NULL,
  count401   integer NOT NULL,
  count403   integer NOT NULL,
  count429   integer NOT NULL,
  shared429  integer NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX rest_invalid_app_ts ON rest_invalid (app_id, ts);

CREATE TABLE rate_limits (
  id          uuid NOT NULL,
  ts          timestamptz NOT NULL,
  app_id      bigint NOT NULL,
  scope       text NOT NULL,
  global      boolean NOT NULL,
  route       text NOT NULL,
  method      text NOT NULL,
  retry_after double precision NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX rate_limits_app_ts ON rate_limits (app_id, ts);

CREATE TABLE custom_events (
  id        uuid NOT NULL,
  ts        timestamptz NOT NULL,
  app_id    bigint NOT NULL,
  name      text NOT NULL,
  props     jsonb NOT NULL DEFAULT '{}',
  user_hash bytea,
  guild_id  bigint,
  weight    real NOT NULL DEFAULT 1,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX custom_events_app_name_ts ON custom_events (app_id, name, ts);

CREATE TABLE webhook_events (
  id               uuid NOT NULL,
  ts               timestamptz NOT NULL,
  app_id           bigint NOT NULL,
  type             text NOT NULL,
  integration_type smallint,
  user_hash        bytea,
  actor_enc        bytea,                    -- audit mode only (installer)
  guild_id         bigint,
  scopes           text[],
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE gauges (
  app_id  bigint NOT NULL,
  ts      timestamptz NOT NULL,
  name    text NOT NULL,
  shard   smallint NOT NULL DEFAULT -1,      -- -1 = process-wide
  instance text NOT NULL DEFAULT '',
  value   double precision NOT NULL,
  PRIMARY KEY (app_id, name, shard, instance, ts)
) PARTITION BY RANGE (ts);

-- ---------- audit mode (M2) ----------

CREATE TABLE audit_log (
  interaction_id uuid NOT NULL,
  ts             timestamptz NOT NULL,
  app_id         bigint NOT NULL,
  actor_lookup   bytea NOT NULL,
  actor_enc      bytea NOT NULL,
  names_enc      bytea,
  guild_id       bigint,
  kind           smallint NOT NULL,
  command        text,
  sub            text,
  custom_id      text,
  outcome        smallint NOT NULL,
  ack_ms         integer,
  PRIMARY KEY (interaction_id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX audit_log_actor ON audit_log (app_id, actor_lookup, ts);
CREATE INDEX audit_log_guild ON audit_log (app_id, guild_id, ts);

CREATE TABLE audit_access_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  app_id         bigint NOT NULL,
  viewer_user_id bigint NOT NULL,
  action         text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'
);

-- ---------- servers ----------

CREATE TABLE guilds (
  app_id              bigint NOT NULL,
  guild_id            bigint NOT NULL,
  name                text NOT NULL DEFAULT '',
  icon                text,
  member_count        integer NOT NULL DEFAULT 0,
  size_at_join        integer,              -- NULL until the first profile arrives
  large               boolean,
  preferred_locale    text,
  features            text[] NOT NULL DEFAULT '{}',
  premium_tier        smallint,
  boosts              integer,
  verification_level  smallint,
  nsfw_level          smallint,
  mfa_level           smallint,
  created_at          timestamptz,
  joined_at           timestamptz NOT NULL,
  left_at             timestamptz,
  shard               smallint,
  channel_counts      jsonb,
  role_count          integer,
  emoji_count         integer,
  sticker_count       integer,
  bot_permissions     numeric(20, 0),
  owner_enc           bytea,                 -- audit mode only
  detected_at_startup boolean NOT NULL DEFAULT false,
  baseline            boolean NOT NULL DEFAULT false, -- imported by the first snapshot, not a join
  first_command_at    timestamptz,
  last_command_at     timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, guild_id)
);
CREATE INDEX guilds_app_active ON guilds (app_id) WHERE left_at IS NULL;

CREATE TABLE guild_events (
  app_id              bigint NOT NULL,
  guild_id            bigint NOT NULL,
  ts                  timestamptz NOT NULL,
  kind                smallint NOT NULL,     -- 1 join, 2 leave, 3 unavailable, 4 available
  detected_at_startup boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_id, guild_id, ts, kind)
);
CREATE INDEX guild_events_app_ts ON guild_events (app_id, ts);

-- Snapshots held back while a new shard layout is still reporting (no diff until every shard of it has reported).
CREATE TABLE snapshot_pending (
  app_id       bigint NOT NULL,
  shard_count  integer NOT NULL,
  shard        integer NOT NULL,
  guilds       bigint[] NOT NULL,
  ts           timestamptz NOT NULL,
  PRIMARY KEY (app_id, shard_count, shard)
);

CREATE TABLE command_registry (
  app_id        bigint NOT NULL,
  command_id    bigint NOT NULL,
  name          text NOT NULL,
  type          smallint NOT NULL,
  guild_id      bigint,
  subcommands   text[] NOT NULL DEFAULT '{}',
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, command_id)
);

CREATE TABLE command_permissions (
  id          uuid NOT NULL,
  ts          timestamptz NOT NULL,
  app_id      bigint NOT NULL,
  guild_id    bigint NOT NULL,
  command_id  bigint NOT NULL,
  overwrites  integer NOT NULL,
  PRIMARY KEY (id, ts)
);

-- ---------- uniques (hashes live only until their salt is destroyed) ----------

CREATE TABLE uniques (
  app_id      bigint NOT NULL,
  period      text NOT NULL,
  day         date NOT NULL,
  scope       text NOT NULL,                  -- 'global', 'command', 'guild', 'locale', 'install'
  scope_key   text NOT NULL,
  user_hash   bytea NOT NULL,
  PRIMARY KEY (app_id, period, scope, scope_key, day, user_hash)
) PARTITION BY LIST (period);

CREATE TABLE unique_counts (
  app_id      bigint NOT NULL,
  grain       text NOT NULL CHECK (grain IN ('day', 'week', 'month')),
  start_day   date NOT NULL,
  scope       text NOT NULL,
  scope_key   text NOT NULL,
  users       integer NOT NULL,
  new_users   integer NOT NULL,
  final       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_id, grain, start_day, scope, scope_key)
);

-- ---------- rollups ----------

CREATE TABLE rollup_1m (
  app_id     bigint NOT NULL,
  bucket     timestamptz NOT NULL,
  metric     text NOT NULL,
  dims_hash  bytea NOT NULL,
  dims       jsonb NOT NULL,
  count      double precision NOT NULL,
  sum        double precision NOT NULL DEFAULT 0,
  min        double precision,
  max        double precision,
  hist       integer[],
  PRIMARY KEY (app_id, metric, dims_hash, bucket)
) PARTITION BY RANGE (bucket);
CREATE INDEX rollup_1m_app_metric_bucket ON rollup_1m (app_id, metric, bucket);
-- Hourly and daily rollups are small (counts only): plain tables, trimmed by date (ADR 0010).
CREATE TABLE rollup_1h (LIKE rollup_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE rollup_1h ADD PRIMARY KEY (app_id, metric, dims_hash, bucket);
CREATE INDEX rollup_1h_app_metric_bucket ON rollup_1h (app_id, metric, bucket);
CREATE TABLE rollup_1d (LIKE rollup_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE rollup_1d ADD PRIMARY KEY (app_id, metric, dims_hash, bucket);
CREATE INDEX rollup_1d_app_metric_bucket ON rollup_1d (app_id, metric, bucket);

CREATE TABLE dirty_buckets (
  app_id  bigint NOT NULL,
  bucket  timestamptz NOT NULL,              -- minute that received late events
  PRIMARY KEY (app_id, bucket)
);

-- ---------- gateway, premium, app ----------

CREATE TABLE shard_events (
  app_id      bigint NOT NULL,
  ts          timestamptz NOT NULL,
  shard       smallint NOT NULL,
  state       text NOT NULL,
  close_code  integer,
  replayed    integer,
  PRIMARY KEY (app_id, shard, ts, state)
);

CREATE TABLE entitlements (
  app_id           bigint NOT NULL,
  ts               timestamptz NOT NULL,
  action           text NOT NULL,
  sku_id           bigint NOT NULL,
  entitlement_type smallint NOT NULL,
  owner            text NOT NULL,
  user_hash        bytea,
  guild_id         bigint,
  starts_at        timestamptz,
  ends_at          timestamptz,
  source           text NOT NULL,             -- 'gateway' or 'webhook'
  PRIMARY KEY (app_id, ts, sku_id, action)
);

CREATE TABLE subscriptions (
  id           uuid NOT NULL,
  ts           timestamptz NOT NULL,
  app_id       bigint NOT NULL,
  action       text NOT NULL,
  status       smallint NOT NULL,
  sku_ids      bigint[] NOT NULL,
  user_hash    bytea NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  PRIMARY KEY (id, ts)
);

CREATE TABLE app_info (
  app_id                   bigint PRIMARY KEY REFERENCES apps ON DELETE CASCADE,
  ts                       timestamptz NOT NULL,
  name                     text NOT NULL,
  approx_guilds            integer,
  approx_user_installs     integer,
  approx_user_auths        integer,
  dashboard_user_ids       bigint[] NOT NULL DEFAULT '{}',
  event_webhooks_status    smallint,
  skus                     jsonb NOT NULL DEFAULT '[]',
  session_start_remaining  integer,
  session_start_total      integer,
  node_version             text,
  lib_version              text,
  sdk_version              text,
  release                  text
);

CREATE TABLE sdk_health (
  app_id          bigint NOT NULL,
  instance        text NOT NULL,
  ts              timestamptz NOT NULL,
  shards          integer[] NOT NULL DEFAULT '{}',
  queue_depth     integer NOT NULL,
  dropped         jsonb NOT NULL,
  failed_flushes  integer NOT NULL,
  internal_errors jsonb NOT NULL,
  sdk_version     text,
  PRIMARY KEY (app_id, instance)
);

-- ---------- admin ----------

CREATE TABLE settings (
  app_id  bigint NOT NULL REFERENCES apps ON DELETE CASCADE,
  key     text NOT NULL,
  value   jsonb NOT NULL,
  PRIMARY KEY (app_id, key)
);

CREATE TABLE alert_rules (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id      bigint NOT NULL REFERENCES apps ON DELETE CASCADE,
  name        text NOT NULL,
  metric      text NOT NULL,
  comparator  text NOT NULL CHECK (comparator IN ('>', '>=', '<', '<=')),
  threshold   double precision NOT NULL,
  window_s    integer NOT NULL CHECK (window_s BETWEEN 60 AND 86400),
  webhook_enc bytea NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  last_fired  timestamptz
);

CREATE TABLE sessions (
  id_sha256   bytea PRIMARY KEY,
  user_id     bigint,                         -- NULL for read-key sessions
  app_id      bigint NOT NULL,
  method      text NOT NULL CHECK (method IN ('discord', 'read_key')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE admin_audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  app_id    bigint NOT NULL,
  user_id   bigint,
  action    text NOT NULL,
  details   jsonb NOT NULL DEFAULT '{}'
);

-- ---------- histogram helpers (match @shardlens/core: 40 log buckets, 1 ms .. 60 s) ----------

CREATE FUNCTION shardlens_bucket(ms double precision) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ms IS NULL THEN NULL
              WHEN ms <= 1 THEN 0
              ELSE least(39, greatest(0, floor(ln(ms) / ln(60000) * 39)::int)) END
$$;

CREATE FUNCTION shardlens_hist_one(ms double precision, w real) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ms IS NULL THEN NULL ELSE
    ARRAY(SELECT CASE WHEN g = shardlens_bucket(ms) THEN round(w)::int ELSE 0 END
          FROM generate_series(0, 39) AS g ORDER BY g) END
$$;

CREATE FUNCTION shardlens_array_add(a integer[], b integer[]) RETURNS integer[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a ELSE
    ARRAY(SELECT coalesce(x, 0) + coalesce(y, 0)
          FROM unnest(a, b) WITH ORDINALITY AS t(x, y, i) ORDER BY i) END
$$;

CREATE AGGREGATE shardlens_hist_sum(integer[]) (SFUNC = shardlens_array_add, STYPE = integer[]);

-- Approximate quantile from a 40-bucket histogram: upper bound of the bucket where the cumulative share reaches q.
CREATE FUNCTION shardlens_hist_quantile(h integer[], q double precision) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH t AS (SELECT sum(x) AS total FROM unnest(h) AS x),
       c AS (SELECT i, sum(x) OVER (ORDER BY i) AS cum FROM unnest(h) WITH ORDINALITY AS u(x, i))
  SELECT CASE WHEN (SELECT total FROM t) IS NULL OR (SELECT total FROM t) = 0 THEN NULL ELSE
    exp(((SELECT min(i) FROM c WHERE cum > 0 AND cum::double precision / (SELECT total FROM t) >= q))::double precision
        / 39 * ln(60000)) END
$$;

-- Creates daily range partitions [from_day, to_day] for the given parent tables. Identifiers come from code, never input.
CREATE FUNCTION shardlens_ensure_daily_partitions(parents text[], from_day date, to_day date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  p text;
  d date;
  created integer := 0;
  part text;
BEGIN
  FOREACH p IN ARRAY parents LOOP
    d := from_day;
    WHILE d <= to_day LOOP
      part := format('%s_%s', p, to_char(d, 'YYYYMMDD'));
      IF to_regclass(part) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       part, p, to_char(d, 'YYYY-MM-DD') || ' 00:00:00+00', to_char(d + 1, 'YYYY-MM-DD') || ' 00:00:00+00');
        created := created + 1;
      END IF;
      d := d + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END
$$;
