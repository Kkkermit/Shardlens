import { z } from 'zod';

const Env = z.object({
  DISCORD_TOKEN: z.string().min(50),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
  SHARDLENS_URL: z.string().optional(),
  SHARDLENS_INGEST_KEY: z.string().optional(),
});

export const env = Env.parse(process.env);
