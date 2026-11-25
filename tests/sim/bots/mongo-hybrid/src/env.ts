import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  DISCORD_TOKEN: z.string().min(50, 'DISCORD_TOKEN looks too short'),
  DISCORD_CLIENT_ID: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  DATABASE_URL: z
    .string()
    .url()
    .refine((url) => url.startsWith('mongodb://') || url.startsWith('mongodb+srv://'), {
      message: 'DATABASE_URL must be a mongodb:// or mongodb+srv:// connection string',
    }),
  STAFF_ROLE_ID: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
