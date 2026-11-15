-- A read-key session remembers its key, so revoking the key ends the dashboard sessions opened with it too.
ALTER TABLE sessions ADD COLUMN key_id bigint REFERENCES api_keys ON DELETE CASCADE;
-- Older read-key sessions can't be traced to their key, so they end here: the dashboard asks for the key again.
DELETE FROM sessions WHERE method = 'read_key';
