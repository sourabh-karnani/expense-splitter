import { config } from 'dotenv';
import { z } from 'zod';

config({ quiet: true });

// Fail fast at startup if configuration is missing or invalid.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGO_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
});

export const env = schema.parse(process.env);
export const isProd = env.NODE_ENV === 'production';
