import { model, Schema } from 'mongoose';

const feedbackSchema = new Schema(
  {
    guildId: { type: String },
    userId: { type: String, required: true },
    text: { type: String, required: true, maxlength: 4000 },
  },
  { timestamps: true },
);

export const Feedback = model('Feedback', feedbackSchema);
