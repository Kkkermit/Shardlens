import { type InferSchemaType, model, Schema } from 'mongoose';

const ticketSchema = new Schema(
  {
    guildId: { type: String, required: true },
    number: { type: Number, required: true },
    userId: { type: String, required: true },
    category: { type: String, required: true },
    details: { type: String, default: '' },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    closedBy: { type: String },
    closedAt: { type: Date },
  },
  { timestamps: true },
);

ticketSchema.index({ guildId: 1, userId: 1, status: 1 });
ticketSchema.index({ guildId: 1, number: 1 }, { unique: true });

export type TicketDoc = InferSchemaType<typeof ticketSchema>;
export const Ticket = model('Ticket', ticketSchema);
