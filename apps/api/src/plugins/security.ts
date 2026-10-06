/**
 * FASTIFY PLUGINS — auth preHandler (server-side RBAC §21), error envelope (§23),
 * simple in-memory sliding-window rate limiter (Redis-backed in prod, same interface).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { Role, ErrorCode, type RoleT } from '@testmobil/shared';
import { verifyToken, type TokenClaims } from '../modules/auth/service.js';
import { AppError } from '../errors.js';
import type { EnvT } from '../env.js';

declare module 'fastify' {
  interface FastifyRequest { claims?: TokenClaims }
}

export const ctxFromClaims = (c: TokenClaims) => ({
  userId: c.sub,
  role: c.role,
  actor: (c.role === Role.CUSTOMER ? 'CUSTOMER' : c.role === Role.DRIVER ? 'DRIVER' : 'ADMIN') as 'CUSTOMER' | 'DRIVER' | 'ADMIN',
});

/** Auth plugin: attaches claims when Authorization: Bearer present. */
export const authPlugin = fp(async (app: FastifyInstance, opts: { env: EnvT }) => {
  app.decorateRequest('claims', undefined);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      req.claims = await verifyToken(h.slice(7), opts.env);
    }
  });
});

export function requireAuth(req: FastifyRequest): TokenClaims {
  if (!req.claims) throw AppError.unauthenticated();
  return req.claims;
}

/**
 * Route guard factory for fastify `preHandler`:
 *   app.get('/x', { preHandler: requireRoles(Role.ADMIN) }, handler)
 * Throws AppError → canonical envelope via the error handler (§21 server-side gate).
 */
export function requireRoles(...roles: RoleT[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const claims = requireAuth(req);
    if (!roles.includes(claims.role)) throw AppError.forbidden(`Requires role ${roles.join('/')}.`);
  };
}

/**
 * In-handler claim extraction + role check (throws AppError → canonical envelope).
 * This is the only supported way to obtain claims inside a route body.
 */
export function authorize(req: FastifyRequest, ...roles: RoleT[]): TokenClaims {
  const claims = requireAuth(req);
  if (roles.length && !roles.includes(claims.role)) throw AppError.forbidden(`Requires role ${roles.join('/')}.`);
  return claims;
}

/** Error handler → canonical envelope {code,message,details,requestId}. */
export const errorEnvelopePlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((err: any, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError || (err.code && typeof err.httpStatus === 'number')) {
      const ae = err as AppError;
      return reply.status(ae.httpStatus).send({ code: ae.code ?? ErrorCode.INTERNAL, message: ae.message, details: ae.details, requestId });
    }
    if (err.validation || err.statusCode === 400) {
      return reply.status(400).send({ code: ErrorCode.VALIDATION_FAILED, message: 'Invalid request.', details: err.message, requestId });
    }
    req.log.error(err, 'unhandled error');
    return reply.status(500).send({ code: ErrorCode.INTERNAL, message: 'Internal server error.', requestId });
  });
});

/** Rate limiting (per IP+route class). SOS route is exempt from hard-block (§7 note in proposal). */
const buckets = new Map<string, number[]>();
export const rateLimitPlugin = fp(async (app: FastifyInstance, opts: { maxPerMin: number }) => {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.includes('/sos')) return; // never throttle emergency path into silence
    const key = `${req.ip}:${req.method}`;
    const now = Date.now();
    const arr = (buckets.get(key) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    buckets.set(key, arr);
    if (arr.length > opts.maxPerMin) {
      reply.header('retry-after', 30);
      throw AppError.rateLimited();
    }
  });
});
