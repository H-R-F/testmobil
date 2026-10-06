/**
 * END-TO-END API TESTS — the brief's critical guarantees, enforced through REAL HTTP
 * routes (fastify.inject), proving server-side validation of state machine, handover
 * gate, RBAC, matching, and settlement. This is the Phase 2–10 quality spine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { resetDb, db } from '../src/db/store.js';
import { TripState } from '@testmobil/shared';

let app: FastifyInstance;
beforeEach(async () => {
  resetDb();
  app = await buildApp();
});

async function regCustomer(email = `c${Math.random()}@x.io`) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register/customer', payload: { email, password: 'supersecret1', fullName: 'Claire Customer', phone: '+491511234' } });
  expect(r.statusCode).toBe(201);
  return { token: r.json().accessToken, auth: { authorization: `Bearer ${r.json().accessToken}` }, id: r.json().user.id };
}
async function regDriver(email = `d${Math.random()}@x.io`) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register/driver', payload: { email, password: 'supersecret1', fullName: 'Dana Driver', phone: '+491519999', licenceNumber: 'L-99201', licenceExpiry: '2030-05-01', canDriveManual: true } });
  expect(r.statusCode).toBe(201);
  return { token: r.json().accessToken, auth: { authorization: `Bearer ${r.json().accessToken}` }, id: r.json().user.id };
}
async function regAdmin() {
  // Admin bootstrap: register via driver route then promote in DB (prod uses seeded admin + env bootstrap)
  const d = await regDriver(`a${Math.random()}@x.io`);
  // Admin bootstrap (prod: seeded admin + env credentials): promote BEFORE re-login so the
  // issued JWT carries the ADMIN role — tokens are signed snapshots, not live lookups.
  db.users.get(d.id)!.role = 'ADMIN';
  const t = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: db.users.get(d.id)!.email, password: 'supersecret1' } });
  return { auth: { authorization: `Bearer ${t.json().accessToken}` }, id: d.id };
}
async function verifyDriver(adminAuth: any, driverId: string) {
  const pend = (await app.inject({ method: 'GET', url: '/api/v1/admin/verifications/pending', headers: adminAuth })).json() as any[];
  const mine = pend.filter((v) => v.driverId === driverId);
  expect(mine.length).toBeGreaterThan(0); // IDENTITY + LICENSE records exist (§4B)
  for (const v of mine) {
    const r = await app.inject({ method: 'POST', url: `/api/v1/admin/verifications/${v.id}/review`, headers: adminAuth, payload: { approve: true } });
    expect(r.statusCode).toBe(200);
  }
}

/** Driver accepts their pending offer via the real HTTP route (matching §9 is offer-based, never auto-assign). */
async function acceptOfferFor(d: { auth: any }, tripId: string) {
  const dash = (await app.inject({ method: 'GET', url: '/api/v1/drivers/dashboard', headers: d.auth })).json() as any;
  const offer = (dash.pendingOffers ?? []).find((o: any) => o.tripId === tripId);
  expect(offer, 'driver should have a pending offer for this trip').toBeTruthy();
  const r = await app.inject({ method: 'POST', url: `/api/v1/matching/offers/${offer.id}/accept`, headers: d.auth });
  expect(r.statusCode).toBe(200);
  return r.json().trip;
}

describe('auth & rbac (§4/§21)', () => {
  it('rejects weak passwords and duplicate emails with canonical envelopes', async () => {
    const weak = await app.inject({ method: 'POST', url: '/api/v1/auth/register/customer', payload: { email: 'w@x.io', password: 'short', fullName: 'W', phone: '+49123456' } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe('VALIDATION_FAILED');
    await regCustomer('dup@x.io');
    const dup = await app.inject({ method: 'POST', url: '/api/v1/auth/register/customer', payload: { email: 'dup@x.io', password: 'supersecret1', fullName: 'Dup', phone: '+49123456' } });
    expect(dup.statusCode).toBe(409);
  });

  it('login failure does not leak which field was wrong', async () => {
    await regCustomer('leak@x.io');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'leak@x.io', password: 'wrongpass123' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().message).toBe('Invalid email or password.');
  });

  it('customer cannot hit driver endpoints (server-side role gate)', async () => {
    const c = await regCustomer();
    const r = await app.inject({ method: 'POST', url: '/api/v1/drivers/availability', headers: c.auth, payload: { state: 'ONLINE' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('FORBIDDEN');
  });

  it('unauthenticated trip access is rejected', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/trips/abc' });
    expect(r.statusCode).toBe(401);
  });
});

describe('driver verification gate (§4B/§9)', () => {
  it('unverified driver cannot go online', async () => {
    const d = await regDriver();
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.52, lng: 13.405 } });
    const r = await app.inject({ method: 'POST', url: '/api/v1/drivers/availability', headers: d.auth, payload: { state: 'ONLINE' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('DRIVER_NOT_VERIFIED');
  });

  it('after admin approval, driver goes ONLINE', async () => {
    const admin = await regAdmin();
    const d = await regDriver();
    await verifyDriver(admin.auth, d.id);
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.52, lng: 13.405 } });
    const r = await app.inject({ method: 'POST', url: '/api/v1/drivers/availability', headers: d.auth, payload: { state: 'ONLINE' } });
    expect(r.json().availability).toBe('ONLINE');
  });
});

describe('booking flow: quote → confirm (§5/§9/§10)', () => {
  it('produces itemized quote and freezes snapshot onto trip at confirmation', async () => {
    const c = await regCustomer();
    await app.inject({ method: 'POST', url: '/api/v1/customers/vehicles', headers: c.auth, payload: { plate: 'B-TM-1234', make: 'VW', model: 'Golf', transmission: 'AUTOMATIC' } });
    const vehicles = (await app.inject({ method: 'GET', url: '/api/v1/customers/vehicles', headers: c.auth })).json() as any[];
    const q = (await app.inject({ method: 'POST', url: '/api/v1/pricing/quote', headers: c.auth, payload: { pickup: { lat: 52.52, lng: 13.405 }, destination: { lat: 52.535, lng: 13.42 } } })).json();
    expect(q.breakdown.items.map((i: any) => i.key)).toContain('BASE_FEE');
    const t = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: c.auth, payload: { quoteId: q.id, vehicleId: vehicles[0].id } });
    expect(t.statusCode).toBe(200);
    expect(t.json().status).toBe(TripState.REQUESTED);
    expect(t.json().quoteSnapshot.totalMinor).toBe(q.breakdown.totalMinor);
    // quote cannot be reused
    const again = await app.inject({ method: 'POST', url: '/api/v1/trips', headers: c.auth, payload: { quoteId: q.id, vehicleId: vehicles[0].id } });
    expect(again.statusCode).toBe(409);
  });

  it('no drivers available path emits NO search crash and keeps trip cancellable', async () => {
    const c = await regCustomer();
    await app.inject({ method: 'POST', url: '/api/v1/customers/vehicles', headers: c.auth, payload: { plate: 'B-X-1', make: 'Audi', model: 'A4', transmission: 'AUTOMATIC' } });
    const vehicles = (await app.inject({ method: 'GET', url: '/api/v1/customers/vehicles', headers: c.auth })).json() as any[];
    const q = (await app.inject({ method: 'POST', url: '/api/v1/pricing/quote', headers: c.auth, payload: { pickup: { lat: 52.52, lng: 13.405 }, destination: { lat: 52.54, lng: 13.43 } } })).json();
    const trip = (await app.inject({ method: 'POST', url: '/api/v1/trips', headers: c.auth, payload: { quoteId: q.id, vehicleId: vehicles[0].id } })).json();
    expect(trip.status).toBe(TripState.SEARCHING_DRIVER); // no eligible drivers → stays searching w/ notice event
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: c.auth, payload: { to: TripState.CANCELLED_BY_CUSTOMER } });
    expect(cancel.statusCode).toBe(200);
  });
});

describe('full happy path dispatch + handover + completion (§7/§8/§11)', () => {
  async function setup() {
    const admin = await regAdmin();
    const c = await regCustomer();
    const d = await regDriver();
    await verifyDriver(admin.auth, d.id);
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.521, lng: 13.406 } });
    await app.inject({ method: 'POST', url: '/api/v1/drivers/availability', headers: d.auth, payload: { state: 'ONLINE' } });
    await app.inject({ method: 'POST', url: '/api/v1/customers/vehicles', headers: c.auth, payload: { plate: 'B-H-1', make: 'BMW', model: '320i', transmission: 'MANUAL' } });
    const vehicles = (await app.inject({ method: 'GET', url: '/api/v1/customers/vehicles', headers: c.auth })).json() as any[];
    const q = (await app.inject({ method: 'POST', url: '/api/v1/pricing/quote', headers: c.auth, payload: { pickup: { lat: 52.52, lng: 13.405 }, destination: { lat: 52.545, lng: 13.44 } } })).json();
    let trip = (await app.inject({ method: 'POST', url: '/api/v1/trips', headers: c.auth, payload: { quoteId: q.id, vehicleId: vehicles[0].id } })).json();
    expect(trip.status).toBe(TripState.SEARCHING_DRIVER); // offers created for eligible drivers
    trip = await acceptOfferFor(d, trip.id);              // real acceptance path (§9)
    expect(trip.status).toBe(TripState.DRIVER_ASSIGNED);
    return { admin, c, d, trip, vehicles };
  }

  it('cannot start trip without dual-confirmed handover (core safety gate)', async () => {
    const { c, d, trip } = await setup();
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.DRIVER_EN_ROUTE } });
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.52, lng: 13.405 } });
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.DRIVER_ARRIVED } });
    // try to jump straight to started → invalid transition
    const illegal = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.TRIP_STARTED } });
    expect(illegal.statusCode).toBe(422);
    expect(illegal.json().code).toBe('TRIP_INVALID_TRANSITION');

    const ho = (await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/handover/before`, headers: d.auth, payload: { odometerKm: 45210, fuelLevelPercent: 62, damageNotes: [{ location: 'rear bumper', description: 'existing scratch' }], gps: { lat: 52.52, lng: 13.405 } } })).json();
    // customer tries to confirm before driver signed
    const early = await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-customer`, headers: c.auth, payload: {} });
    expect(early.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-driver`, headers: d.auth, payload: {} });
    const cust = await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-customer`, headers: c.auth, payload: {} });
    expect(cust.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/v1/trips/${trip.id}`, headers: c.auth });
    expect(after.json().status).toBe(TripState.HANDOVER_CONFIRMED);
    // now start is legal
    const start = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.TRIP_STARTED } });
    expect(start.json().status).toBe(TripState.TRIP_STARTED);
  });

  it('completes trip: capture payment, payout split recorded, driver freed, rating works', async () => {
    const { c, d, trip } = await setup();
    const st = [TripState.DRIVER_EN_ROUTE];
    let cur = trip.id;
    const seq = [TripState.DRIVER_EN_ROUTE, TripState.DRIVER_ARRIVED];
    for (const s of seq) {
      if (s === TripState.DRIVER_ARRIVED) await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.52, lng: 13.405 } });
      await app.inject({ method: 'POST', url: `/api/v1/trips/${cur}/transition`, headers: d.auth, payload: { to: s } });
    }
    const ho = (await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/handover/before`, headers: d.auth, payload: { odometerKm: 45210, fuelLevelPercent: 62, gps: { lat: 52.52, lng: 13.405 } } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-driver`, headers: d.auth, payload: {} });
    await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-customer`, headers: c.auth, payload: {} });
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.TRIP_STARTED } });
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.ARRIVING } });
    const done = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.TRIP_COMPLETED } });
    expect(done.json().status).toBe(TripState.TRIP_COMPLETED);

    const pay = db.payments.get(trip.id)!;
    expect(pay.status).toBe('CAPTURED');
    expect(pay.commissionMinor + pay.payoutMinor).toBe(pay.amountMinor);
    // terminal state locked
    const after = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.EMERGENCY } });
    expect(after.statusCode).toBe(409);
    expect(after.json().code).toBe('TRIP_TERMINAL_STATE');
    // driver back ONLINE
    expect(db.drivers.get(d.id)!.availability).toBe('ONLINE');
    // rating
    const rate = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/rating`, headers: c.auth, payload: { score: 5, comment: 'Great!' } });
    expect(rate.statusCode).toBe(200);
    const reRate = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/rating`, headers: c.auth, payload: { score: 1 } });
    expect(reRate.statusCode).toBe(409);
  });

  it('third-party user cannot read or act on someone else\'s trip (row-level ownership)', async () => {
    const { trip } = await setup();
    const stranger = await regCustomer();
    const read = await app.inject({ method: 'GET', url: `/api/v1/trips/${trip.id}`, headers: stranger.auth });
    expect(read.statusCode).toBe(403);
    const act = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: stranger.auth, payload: { to: TripState.CANCELLED_BY_CUSTOMER } });
    expect(act.statusCode).toBe(403);
  });

  it('customer cannot fake a SYSTEM transition (actor spoofing blocked §21)', async () => {
    const { c, trip } = await setup();
    const r = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: c.auth, payload: { to: TripState.DRIVER_EN_ROUTE } });
    expect(r.statusCode).toBe(422); // actor derived server-side as CUSTOMER → forbidden by rule
  });

  it('arrival GPS check blocks far-away "arrived" claims', async () => {
    const { d, trip } = await setup();
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.DRIVER_EN_ROUTE } });
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 48.137, lng: 11.575 } }); // Munich, far from Berlin pickup
    const r = await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.DRIVER_ARRIVED } });
    expect(r.statusCode).toBe(400);
  });
});

describe('SOS & incidents (§13)', () => {
  it('SOS during trip creates CRITICAL incident, moves trip to EMERGENCY, admin resolves', async () => {
    const admin = await regAdmin();
    const c = await regCustomer();
    const d = await regDriver();
    await verifyDriver(admin.auth, d.id);
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.521, lng: 13.406 } });
    await app.inject({ method: 'POST', url: '/api/v1/drivers/availability', headers: d.auth, payload: { state: 'ONLINE' } });
    await app.inject({ method: 'POST', url: '/api/v1/customers/vehicles', headers: c.auth, payload: { plate: 'B-S-1', make: 'Ford', model: 'Focus', transmission: 'AUTOMATIC' } });
    const vehicles = (await app.inject({ method: 'GET', url: '/api/v1/customers/vehicles', headers: c.auth })).json() as any[];
    const q = (await app.inject({ method: 'POST', url: '/api/v1/pricing/quote', headers: c.auth, payload: { pickup: { lat: 52.52, lng: 13.405 }, destination: { lat: 52.545, lng: 13.44 } } })).json();
    const trip = (await app.inject({ method: 'POST', url: '/api/v1/trips', headers: c.auth, payload: { quoteId: q.id, vehicleId: vehicles[0].id } })).json();
    // fast-forward to TRIP_STARTED
    for (const s of [TripState.DRIVER_EN_ROUTE]) await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: s } });
    await app.inject({ method: 'POST', url: '/api/v1/drivers/location-ping', headers: d.auth, payload: { lat: 52.52, lng: 13.405 } });
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.DRIVER_ARRIVED } });
    const ho = (await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/handover/before`, headers: d.auth, payload: { odometerKm: 100, gps: { lat: 52.52, lng: 13.405 } } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-driver`, headers: d.auth });
    await app.inject({ method: 'POST', url: `/api/v1/handovers/${ho.id}/confirm-customer`, headers: c.auth });
    await app.inject({ method: 'POST', url: `/api/v1/trips/${trip.id}/transition`, headers: d.auth, payload: { to: TripState.TRIP_STARTED } });

    const sos = await app.inject({ method: 'POST', url: '/api/v1/incidents/sos', headers: c.auth, payload: { tripId: trip.id, gps: { lat: 52.53, lng: 13.42 }, message: 'I feel unsafe' } });
    expect(sos.statusCode).toBe(200);
    expect(sos.json().note).toContain('emergency services');
    const t = await app.inject({ method: 'GET', url: `/api/v1/trips/${trip.id}`, headers: c.auth });
    expect(t.json().status).toBe(TripState.EMERGENCY);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/admin/incidents?status=OPEN', headers: admin.auth })).json() as any[];
    expect(list.some((i) => i.type === 'SOS' && i.severity === 'CRITICAL')).toBe(true);
    const resolve = await app.inject({ method: 'POST', url: `/api/v1/admin/incidents/${list.find((i) => i.type === 'SOS')!.id}/resolve`, headers: admin.auth, payload: { outcome: 'COMPLETE_TRIP' } });
    expect(resolve.statusCode).toBe(200);
  });
});

describe('admin surface (§16)', () => {
  it('stats + pricing rule update reflected in next quote (configurable, not hardcoded)', async () => {
    const admin = await regAdmin();
    const stats = (await app.inject({ method: 'GET', url: '/api/v1/admin/stats', headers: admin.auth })).json();
    expect(stats).toHaveProperty('onlineDrivers');
    const upd = await app.inject({ method: 'POST', url: '/api/v1/admin/pricing-rules', headers: admin.auth, payload: { key: 'BASE_FEE', value: 999 } });
    expect(upd.statusCode).toBe(200);
    const c = await regCustomer();
    const q = (await app.inject({ method: 'POST', url: '/api/v1/pricing/quote', headers: c.auth, payload: { pickup: { lat: 52.52, lng: 13.405 }, destination: { lat: 52.53, lng: 13.41 } } })).json();
    expect(q.breakdown.items.find((i: any) => i.key === 'BASE_FEE').amountMinor).toBe(999);
  });

  it('non-admin cannot reach admin endpoints', async () => {
    const c = await regCustomer();
    const r = await app.inject({ method: 'GET', url: '/api/v1/admin/stats', headers: c.auth });
    expect(r.statusCode).toBe(403);
  });
});
