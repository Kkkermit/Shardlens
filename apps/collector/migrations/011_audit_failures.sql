-- The activity log can be narrowed to failed runs ("who hit an error in this server?"). Failures are a small share of
-- the log, so these indexes stay small, and the newest failures are read without walking every row that went well.
CREATE INDEX audit_log_failed ON audit_log (app_id, ts) WHERE outcome <> 0;
CREATE INDEX audit_log_guild_failed ON audit_log (app_id, guild_id, ts) WHERE outcome <> 0;
