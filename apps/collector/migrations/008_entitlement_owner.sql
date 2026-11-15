-- Two people buying the same SKU in the same millisecond are two entitlements: the owner is part of what makes one.
ALTER TABLE entitlements DROP CONSTRAINT entitlements_pkey;
ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_event UNIQUE NULLS NOT DISTINCT (app_id, ts, sku_id, action, user_hash, guild_id);
