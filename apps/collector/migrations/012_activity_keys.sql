-- Activity keys read who ran what (audit mode) for a dashboard of the owner's own, where nobody signs in with Discord.
-- Their reads go into the access log like a person's, under the key instead of a Discord user.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scope_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check CHECK (scope IN ('ingest', 'read', 'activity'));
ALTER TABLE audit_access_log ADD COLUMN viewer_key_id bigint REFERENCES api_keys ON DELETE SET NULL;
