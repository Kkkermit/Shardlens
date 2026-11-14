-- Scheduled summaries posted to a Discord channel through its webhook. `hour` and `weekday` are in the app's time zone.

CREATE TABLE reports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id      bigint NOT NULL REFERENCES apps ON DELETE CASCADE,
  name        text NOT NULL,
  schedule    text NOT NULL CHECK (schedule IN ('daily', 'weekly')),
  hour        smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  weekday     smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 1 AND 7), -- ISO: 1 Monday. Weekly reports only.
  webhook_enc bytea NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  last_sent   timestamptz,
  last_error  text
);
CREATE INDEX reports_app ON reports (app_id);
