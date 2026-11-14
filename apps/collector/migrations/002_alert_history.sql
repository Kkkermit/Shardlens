-- M2: alert history, and an index for erasure by user hash.

CREATE TABLE alert_events (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id   bigint NOT NULL REFERENCES alert_rules ON DELETE CASCADE,
  app_id    bigint NOT NULL,
  ts        timestamptz NOT NULL DEFAULT now(),
  value     double precision,
  delivered boolean NOT NULL,
  error     text
);
CREATE INDEX alert_events_app_ts ON alert_events (app_id, ts DESC);

CREATE INDEX interactions_app_user ON interactions (app_id, user_hash);
CREATE INDEX webhook_events_app_ts ON webhook_events (app_id, ts);
