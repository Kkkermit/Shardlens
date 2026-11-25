import type { GuildName } from '../../store.js';
import type { Mongo } from '../connect.js';
import { guildKey } from '../ingest/guilds.js';

/** Names and icons of the app's servers with these IDs, read by `_id` in one round trip. */
export async function guildProfiles(m: Mongo, appId: string, ids: readonly string[]): Promise<GuildName[]> {
  if (ids.length === 0) return [];
  const docs = await m.c.guilds
    .find({ _id: { $in: ids.map((id) => guildKey(appId, id)) } }, { projection: { name: 1, icon: 1 } })
    .toArray();
  return docs.map((d) => ({ id: d._id.guildId, name: d.name, icon: d.icon ?? null }));
}
