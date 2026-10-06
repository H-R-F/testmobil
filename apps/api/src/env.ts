/**
 * ENV LOADING — secrets come from environment ONLY (principle §13/§21).
 * No secret defaults in production: process.env must supply them (§12 rule 12).
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3001),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET too short (or unset)'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  MAPS_PROVIDER: z.enum(['local', 'google', 'mapbox']).default('local'),
  PAYMENTS_PROVIDER: z.enum(['stub', 'stripe']).default('stub'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_MAX_PER_MIN: z.coerce.number().int().default(120),
  AUTH_RATE_LIMIT_MAX_PER_MIN: z.coerce.number().int().default(10),
  OPS_ALERT_WEBHOOK_URL: z.string().optional(),
});

export type EnvT = z.infer<typeof EnvSchema>;

export function loadEnv(overrides: Record<string, string | undefined> = {}): EnvT {
  const merged = { ...process.env, ...overrides };
  if (merged.NODE_ENV === 'test' && !merged.JWT_ACCESS_SECRET) {
    merged.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production-000000';
  }
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration → ${issues}`);
  }
  return parsed.data;
}
