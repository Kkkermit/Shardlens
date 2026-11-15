import mongoose from 'mongoose';

const GuildSettings = mongoose.model(
  'GuildSettings',
  new mongoose.Schema({ guildId: { type: String, unique: true }, prefix: { type: String, default: '!' } }),
);

export async function connectDatabase(uri: string): Promise<void> {
  await mongoose.connect(uri);
}

export async function prefixFor(guildId: string | null): Promise<string> {
  if (!guildId) return '!';
  const settings = await GuildSettings.findOne({ guildId }).lean();
  return settings?.prefix ?? '!';
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
