import { model, Schema } from 'mongoose';

const quoteSchema = new Schema(
  {
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    authorId: { type: String, required: true },
    content: { type: String, default: '' },
    savedBy: { type: String, required: true },
  },
  { timestamps: true },
);

quoteSchema.index({ guildId: 1, messageId: 1 });

export const Quote = model('Quote', quoteSchema);
