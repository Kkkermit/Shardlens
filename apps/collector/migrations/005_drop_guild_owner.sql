-- The server owner's ID is no longer collected. In audit mode a user is the ID, username and avatar on their own
-- interactions, and nothing else.
ALTER TABLE guilds DROP COLUMN owner_enc;
