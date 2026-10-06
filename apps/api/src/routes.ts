/**
 * ROUTES — REST /api/v1 wiring per proposal §7. Routes are thin: zod-validate →
 * call service → serialize. ALL business rules live in services (never here, never in UI).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Role, TripState, isValidLatLng, type LatLng, type TripStateT } from '@testmobil/shared';
import { loadEnv } from './env.js';
import { registerUser, login, issueAccessToken } from './modules/auth/service.js';
import { createQuote, confirmQuoteAndCreateTrip, requestTransition, getTripForParty, listTripsForUser } from './modules/trips/service.js';
import { acceptOffer, declineOffer } from './modules/matching/service.js';
import { startBeforeHandover, driverConfirmHandover, customerConfirmHandover, customerRejectHandover, recordAfterInspection, getHandovers } from './modules/handover/service.js';
import { setAvailability, pingLocation, driverDashboard, rateDriver, adminReviewVerification, listPendingVerifications } from './modules/drivers/service.js';
import { upsertVehicle, listVehicles, setEmergencyContact, getProfile } from './modules/customers/service.js';
import { triggerSos, reportIncident, adminListIncidents, adminResolveIncident } from './modules/incidents/service.js';
import { adminStats, adminListTrips, adminTripTimeline, adminSetUserStatus, adminUpdatePricingRule } from './modules/admin/service.js';
import { db } from './db/store.js';
import { AppError } from './errors.js';
import { ctxFromClaims, authorize } from './plugins/security.js';

const LatLngZ = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const EmailZ = z.string().email().max(254);
const PwZ = z.string().min(8).max(128);

export async function registerRoutes(app: FastifyInstance) {
  const env = loadEnv();

  // ── health ────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true, maps: app.mapsProviderName ?? 'local' }));

  // ── AUTH ──────────────────────────────────────────────────────────────
  app.post('/api/v1/auth/register/customer', {
    config: { rate: 'auth' },
  }, async (req, reply) => {
    const body = z.object({ email: EmailZ, password: PwZ, fullName: z.string().min(2).max(120), phone: z.string().min(6).max(20) }).parse(req.body);
    const user = await registerUser({ ...body, role: Role.CUSTOMER });
    return reply.status(201).send({ accessToken: await issueAccessToken(user, env), user: publicUser(user) });
  });

  app.post('/api/v1/auth/register/driver', { config: { rate: 'auth' } }, async (req, reply) => {
    const body = z.object({
      email: EmailZ, password: PwZ, fullName: z.string().min(2).max(120), phone: z.string().min(6).max(20),
      licenceNumber: z.string().min(3).max(40), licenceExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), canDriveManual: z.boolean(),
    }).parse(req.body);
    if (new Date(body.licenceExpiry) < new Date()) throw AppError.validation('Licence is already expired.');
    const user = await registerUser({ ...body, role: Role.DRIVER, driver: { licenceNumber: body.licenceNumber, licenceExpiry: body.licenceExpiry, canDriveManual: body.canDriveManual } });
    return reply.status(201).send({ accessToken: await issueAccessToken(user, env), user: publicUser(user) });
  });

  app.post('/api/v1/auth/login', { config: { rate: 'auth' } }, async (req) => {
    const body = z.object({ email: EmailZ, password: z.string().min(1).max(128) }).parse(req.body);
    const user = await login(body.email, body.password);
    return { accessToken: await issueAccessToken(user, env), user: publicUser(user) };
  });

  app.get('/api/v1/auth/me', async (req) => {
    const claims = authorize(req, Role.CUSTOMER, Role.DRIVER, Role.ADMIN);
    const u = db.users.get(claims.sub)!;
    return publicUser(u);
  });

  // ── CUSTOMER: profile/vehicles/emergency contact ─────────────────────
  app.post('/api/v1/customers/vehicles', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    const body = z.object({ plate: z.string().min(2).max(15), make: z.string().min(1).max(50), model: z.string().min(1).max(50), transmission: z.enum(['MANUAL', 'AUTOMATIC']) }).parse(req.body);
    return upsertVehicle(ctxFromClaims(claims), body);
  });
  app.get('/api/v1/customers/vehicles', async (req) => listVehicles(ctxFromClaims(authorize(req))));
  app.put('/api/v1/customers/emergency-contact', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    const body = z.object({ name: z.string().min(2).max(120), phone: z.string().min(6).max(20) }).parse(req.body);
    setEmergencyContact(ctxFromClaims(claims), body);
    return { ok: true };
  });
  app.get('/api/v1/customers/profile', async (req) => getProfile(ctxFromClaims(authorize(req))));

  // ── QUOTES & TRIPS (customer flow §5) ─────────────────────────────────
  app.post('/api/v1/pricing/quote', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    const body = z.object({
      pickup: LatLngZ, destination: LatLngZ,
      scheduledFor: z.string().datetime().nullable().optional(),
      promotionCode: z.string().max(32).optional(),
    }).parse(req.body);
    const q = await createQuote(ctxFromClaims(claims), { ...body, scheduledFor: body.scheduledFor ?? null });
    return { id: q.id, expiresAt: q.expiresAt, estimateTripKm: q.tripDistanceKm, breakdown: q.breakdown, currency: q.breakdown.currency };
  });

  app.post('/api/v1/trips', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    const body = z.object({ quoteId: z.string().min(8), vehicleId: z.string().min(8), noteToDriver: z.string().max(300).optional() }).parse(req.body);
    const trip = await confirmQuoteAndCreateTrip(ctxFromClaims(claims), body);
    return serializeTrip(trip);
  });

  app.get('/api/v1/trips/:id', async (req) => {
    const claims = authorize(req);
    const { id } = req.params as { id: string };
    return serializeTrip(getTripForParty(ctxFromClaims(claims), id));
  });

  app.get('/api/v1/trips', async (req) => listTripsForUser(ctxFromClaims(authorize(req))).map(serializeTrip));

  app.post('/api/v1/trips/:id/transition', async (req) => {
    const claims = authorize(req);
    const { id } = req.params as { id: string };
    // NOTE: `actor` is DERIVED SERVER-SIDE from the session — client cannot spoof it (§21).
    const body = z.object({ to: z.enum(Object.values(TripState) as [TripStateT, ...TripStateT[]]), gps: LatLngZ.optional() }).parse(req.body);
    const trip = await requestTransition(ctxFromClaims(claims), id, body.to, body.gps);
    return serializeTrip(trip);
  });

  app.post('/api/v1/trips/:id/rating', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    const body = z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).parse(req.body);
    const { id } = req.params as { id: string };
    rateDriver(ctxFromClaims(claims), id, body.score, body.comment);
    return { ok: true };
  });

  // ── DRIVER FLOW (brief §6) ────────────────────────────────────────────
  app.post('/api/v1/drivers/availability', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    const body = z.object({ state: z.enum(['ONLINE', 'OFFLINE']) }).parse(req.body);
    setAvailability(ctxFromClaims(claims), body.state);
    return { availability: db.drivers.get(claims.sub)!.availability };
  });

  app.post('/api/v1/drivers/location-ping', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    const body = LatLngZ.parse(req.body);
    pingLocation(ctxFromClaims(claims), body);
    return { ok: true };
  });

  app.get('/api/v1/drivers/dashboard', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    return driverDashboard(ctxFromClaims(claims));
  });

  app.post('/api/v1/matching/offers/:offerId/accept', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    const { offerId } = req.params as { offerId: string };
    await acceptOffer(ctxFromClaims(claims), offerId);
    const trip = [...db.trips.values()].find((t) => t.driverId === claims.sub && t.status === TripState.DRIVER_ASSIGNED);
    return { ok: true, trip: trip ? serializeTrip(trip) : null };
  });

  app.post('/api/v1/matching/offers/:offerId/decline', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    declineOffer(ctxFromClaims(claims), (req.params as { offerId: string }).offerId);
    return { ok: true };
  });

  // ── VEHICLE HANDOVER (brief §7) ───────────────────────────────────────
  const HandoverBody = z.object({
    odometerKm: z.number().int().min(0).max(5_000_000).optional(),
    fuelLevelPercent: z.number().min(0).max(100).optional(),
    batteryLevelPercent: z.number().min(0).max(100).optional(),
    damageNotes: z.array(z.object({ location: z.string().min(1).max(60), description: z.string().min(1).max(300) })).max(30).optional(),
    photoKeys: z.array(z.string().min(1).max(200)).max(40).optional(),
    gps: LatLngZ,
  });

  app.post('/api/v1/trips/:id/handover/before', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    const body = HandoverBody.parse(req.body);
    const h = await startBeforeHandover(ctxFromClaims(claims), (req.params as { id: string }).id, body);
    return h;
  });
  app.post('/api/v1/handovers/:handoverId/confirm-driver', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    return driverConfirmHandover(ctxFromClaims(claims), (req.params as { handoverId: string }).handoverId);
  });
  app.post('/api/v1/handovers/:handoverId/confirm-customer', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    return customerConfirmHandover(ctxFromClaims(claims), (req.params as { handoverId: string }).handoverId);
  });
  app.post('/api/v1/handovers/:handoverId/reject', async (req) => {
    const claims = authorize(req, Role.CUSTOMER);
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
    await customerRejectHandover(ctxFromClaims(claims), (req.params as { handoverId: string }).handoverId, body.reason);
    return { ok: true };
  });
  app.post('/api/v1/trips/:id/handover/after', async (req) => {
    const claims = authorize(req, Role.DRIVER);
    const body = HandoverBody.parse(req.body);
    return recordAfterInspection(ctxFromClaims(claims), (req.params as { id: string }).id, body);
  });
  app.get('/api/v1/trips/:id/handovers', async (req) => {
    const claims = authorize(req);
    const id = (req.params as { id: string }).id;
    getTripForParty(ctxFromClaims(claims), id); // ownership check
    return getHandovers(id);
  });

  // ── SAFETY / SOS (brief §13) ──────────────────────────────────────────
  app.post('/api/v1/incidents/sos', async (req) => {
    const claims = authorize(req, Role.CUSTOMER, Role.DRIVER);
    const body = z.object({ tripId: z.string().optional(), gps: LatLngZ.nullable().optional(), message: z.string().max(1000).optional() }).parse(req.body);
    const inc = await triggerSos(ctxFromClaims(claims), { tripId: body.tripId, gps: (body.gps ?? null) as LatLng | null, message: body.message });
    return reply201(req, { incidentId: inc.id, note: 'Ops has been alerted with your live location. If you are in immediate danger, also call local emergency services.' });
  });

  app.post('/api/v1/incidents/report', async (req) => {
    const claims = authorize(req, Role.CUSTOMER, Role.DRIVER);
    const body = z.object({ tripId: z.string().optional(), type: z.enum(['SUPPORT', 'DISPUTE']), severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(), message: z.string().min(3).max(2000) }).parse(req.body);
    return reportIncident(ctxFromClaims(claims), body);
  });

  // ── ADMIN (brief §16) ─────────────────────────────────────────────────
  app.get('/api/v1/admin/stats', async (req) => adminStats(authorize(req, Role.ADMIN).sub));
  app.get('/api/v1/admin/trips', async (req) => {
    authorize(req, Role.ADMIN);
    const q = req.query as Record<string, string>;
    return adminListTrips({ status: q.status, customerId: q.customerId, driverId: q.driverId }).map(serializeTrip);
  });
  app.get('/api/v1/admin/trips/:id/timeline', async (req) => {
    authorize(req, Role.ADMIN);
    return adminTripTimeline((req.params as { id: string }).id);
  });
  app.get('/api/v1/admin/verifications/pending', async (req) => { authorize(req, Role.ADMIN); return listPendingVerifications(); });
  app.post('/api/v1/admin/verifications/:id/review', async (req) => {
    const claims = authorize(req, Role.ADMIN);
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    adminReviewVerification(claims.sub, (req.params as { id: string }).id, body.approve);
    return { ok: true };
  });
  app.post('/api/v1/admin/users/:id/status', async (req) => {
    const claims = authorize(req, Role.ADMIN);
    const body = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }).parse(req.body);
    adminSetUserStatus(claims.sub, (req.params as { id: string }).id, body.status);
    return { ok: true };
  });
  app.post('/api/v1/admin/pricing-rules', async (req) => {
    const claims = authorize(req, Role.ADMIN);
    const body = z.object({ key: z.string(), value: z.number() }).parse(req.body);
    adminUpdatePricingRule(claims.sub, body.key, body.value);
    return { ok: true };
  });
  app.get('/api/v1/admin/incidents', async (req) => { authorize(req, Role.ADMIN); return adminListIncidents((req.query as any).status); });
  app.post('/api/v1/admin/incidents/:id/resolve', async (req) => {
    const claims = authorize(req, Role.ADMIN);
    const body = z.object({ outcome: z.enum(['COMPLETE_TRIP', 'CANCEL_TRIP', 'NONE']) }).parse(req.body);
    await adminResolveIncident(claims.sub, (req.params as { id: string }).id, body.outcome);
    return { ok: true };
  });
}

// helpers ─────────────────────────────────────────────────────────────────
function publicUser(u: NonNullable<ReturnType<typeof asUser>>) {
  return { id: u.id, role: u.role, email: u.email, fullName: u.fullName, status: u.status };
}
type UserT = (typeof db.users extends Map<string, infer V> ? V : never);
function asUser(): UserT { return undefined as any; }

function serializeTrip(t: UserT extends never ? never : import('./db/store.js').TripRow) {
  const customer = db.users.get(t.customerId);
  const driver = t.driverId ? db.users.get(t.driverId) : null;
  const dprof = t.driverId ? db.drivers.get(t.driverId) : null;
  const vehicle = t.vehicleId ? db.vehicles.get(t.vehicleId) : null;
  return {
    id: t.id, status: t.status, createdAt: t.createdAt, scheduledFor: t.scheduledFor,
    origin: t.origin, destination: t.destination, quoteSnapshot: t.quoteSnapshot,
    tripDistanceKm: t.tripDistanceKm, pickupDistanceKm: t.pickupDistanceKm, etaSeconds: t.etaSeconds,
    customer: { id: customer?.id ?? '', fullName: customer?.fullName ?? '' },
    driver: driver ? {
      id: driver.id, fullName: driver.fullName, verified: true,
      ratingAvg: dprof?.ratingCount ? Math.round((dprof.ratingSum / dprof.ratingCount) * 10) / 10 : null,
      ratingCount: dprof?.ratingCount ?? 0, canDriveManual: dprof?.canDriveManual ?? false,
    } : null,
    vehicle: vehicle ? { plate: vehicle.plate, make: vehicle.make, model: vehicle.model, transmission: vehicle.transmission } : undefined,
  };
}

function reply201(_req: any, payload: unknown) { return payload; }
