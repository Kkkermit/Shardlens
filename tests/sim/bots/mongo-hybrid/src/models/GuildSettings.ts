import { type InferSchemaType, model, Schema } from 'mongoose';

export const DEFAULT_CATEGORIES = ['billing', 'bug', 'account', 'other'];

const guildSettingsSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true },
    ticketCounter: { type: Number, default: 0 },
    ticketCategories: { type: [String], default: () => DEFAULT_CATEGORIES },
  },
  { timestamps: true },
);

export type GuildSettingsDoc = InferSchemaType<typeof guildSettingsSchema>;
export const GuildSettings = model('GuildSettings', guildSettingsSchema);

/** Next ticket number for a server, creates the settings doc on first use. */
export async function nextTicketNumber(guildId: string): Promise<number> {
  const settings = await GuildSettings.findOneAndUpdate(
    { guildId },
    { $inc: { ticketCounter: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
  return settings.ticketCounter;
}

export async function ticketCategories(guildId: string): Promise<string[]> {
  const settings = await GuildSettings.findOne({ guildId }).lean();
  return settings?.ticketCategories?.length ? settings.ticketCategories : DEFAULT_CATEGORIES;
}
