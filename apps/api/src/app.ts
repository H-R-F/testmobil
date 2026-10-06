/**
 * FASTIFY APP FACTORY — plugin registration + route mounting.
 * Security headers & CORS per proposal §10. Testable without listening (app.inject).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { loadEnv, type EnvT } from './env.js';
import { authPlugin, errorEnvelopePlugin, rateLimitPlugin } from './plugins/security.js';
import { registerRoutes } from './routes.js';
import { getMapsProvider } from './providers/maps/provider.js';

export async function buildApp(overrides: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  const env: EnvT = loadEnv({ NODE_ENV: 'test', ...overrides });
  const app = Fastify({ logger: false, requestIdLogLabel: 'requestId' });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    credentials: true,
  });
  await app.register(helmet, { global: true });
  await app.register(errorEnvelopePlugin);
  await app.register(authPlugin, { env });
  await app.register(rateLimitPlugin, { maxPerMin: env.RATE_LIMIT_MAX_PER_MIN });

  app.decorate('mapsProviderName', getMapsProvider().name);
  await registerRoutes(app);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { mapsProviderName?: string }
}
