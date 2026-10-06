import fp from 'fastify-plugin';
import { Role, ErrorCode } from '@testmobil/shared';
import { verifyToken } from '../modules/auth/service.js';
import { AppError } from '../errors.js';
import { ZodError } from 'zod';
export const ctxFromClaims = (c) => ({
    userId: c.sub,
    role: c.role,
    actor: (c.role === Role.CUSTOMER ? 'CUSTOMER' : c.role === Role.DRIVER ? 'DRIVER' : 'ADMIN'),
});
/** Auth plugin: attaches claims when Authorization: Bearer present. */
export const authPlugin = fp(async (app, opts) => {
    app.decorateRequest('claims', undefined);
    app.addHook('onRequest', async (req) => {
        const h = req.headers.authorization;
        if (h?.startsWith('Bearer ')) {
            req.claims = await verifyToken(h.slice(7), opts.env);
        }
    });
});
export function requireAuth(req) {
    if (!req.claims)
        throw AppError.unauthenticated();
    return req.claims;
}
/**
 * Route guard factory for fastify `preHandler`:
 *   app.get('/x', { preHandler: requireRoles(Role.ADMIN) }, handler)
 * Throws AppError → canonical envelope via the error handler (§21 server-side gate).
 */
export function requireRoles(...roles) {
    return async (req, _reply) => {
        const claims = requireAuth(req);
        if (!roles.includes(claims.role))
            throw AppError.forbidden(`Requires role ${roles.join('/')}.`);
    };
}
/**
 * In-handler claim extraction + role check (throws AppError → canonical envelope).
 * This is the only supported way to obtain claims inside a route body.
 */
export function authorize(req, ...roles) {
    const claims = requireAuth(req);
    if (roles.length && !roles.includes(claims.role))
        throw AppError.forbidden(`Requires role ${roles.join('/')}.`);
    return claims;
}
/** Error handler → canonical envelope {code,message,details,requestId}. */
export const errorEnvelopePlugin = fp(async (app) => {
    app.setErrorHandler((err, req, reply) => {
        const requestId = req.id;
        if (err instanceof AppError || (err.code && typeof err.httpStatus === 'number')) {
            const ae = err;
            return reply.status(ae.httpStatus).send({ code: ae.code ?? ErrorCode.INTERNAL, message: ae.message, details: ae.details, requestId });
        }
        // Zod schema .parse() failures -> canonical 400 VALIDATION_FAILED envelope (§21 input validation).
        if (err instanceof ZodError) {
            return reply.status(400).send({ code: ErrorCode.VALIDATION_FAILED, message: 'Invalid request.', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`), requestId });
        }
        if (err.validation || err.statusCode === 400) {
            return reply.status(400).send({ code: ErrorCode.VALIDATION_FAILED, message: 'Invalid request.', details: err.message, requestId });
        }
        req.log.error(err, 'unhandled error');
        return reply.status(500).send({ code: ErrorCode.INTERNAL, message: 'Internal server error.', requestId });
    });
});
/** Rate limiting (per IP+route class). SOS route is exempt from hard-block (§7 note in proposal). */
const buckets = new Map();
/** Test hook: clear sliding-window buckets so per-file app rebuilds don't leak 429s. */
export function resetRateLimiter() {
    buckets.clear();
}
export const rateLimitPlugin = fp(async (app, opts) => {
    app.addHook('onRequest', async (req, reply) => {
        if (req.url.includes('/sos'))
            return; // never throttle emergency path into silence
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
