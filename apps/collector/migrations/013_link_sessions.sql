-- Sessions opened with a one-time sign-in link, printed by whoever runs the dashboard from a terminal or in a bot
-- (`npx shardlens dashboard`, the in-bot MongoDB runner): that person already holds the database.
ALTER TABLE sessions DROP CONSTRAINT sessions_method_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_method_check CHECK (method IN ('discord', 'read_key', 'link'));
