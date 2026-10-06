/**
 * TRIP SERVICE — the heart of the platform. Enforces:
 *  - quote → confirm flow with frozen price snapshot (transparency §9/§10)
 *  - state machine validation on EVERY transition (§8, server-side only)
 *  - handover dual-confirmation gate before TRIP_STARTED (§7)
 *  - timestamped status history + audit log for every important action (§3/§21)
 */
import {
  TripState, canTransition, calculatePrice, haversineKm, isActiveTripState,
  type TransitionActor, type LatLng, type TripStateT, Role,
} from '@testmobil/shared';
import { db, newId, type TripRow, type QuoteRow } from '../../db/store.js';
import { AppError } from '../../errors.js';
import { getMapsProvider } from '../../providers/maps/provider.js';
import { getPaymentProvider } from '../../providers/payments/provider.js';
import { publish } from '../realtime/events.js';
import { isDriverVerified } from '../auth/service.js';

export interface SessionCtx { userId: string; role: (typeof Role)[keyof typeof Role]; actor: TransitionActor }

// ── QUOTE ────────────────────────────────────────────────────────────────
export async function createQuote(
  s: SessionCtx,
  input: { pickup: LatLng; destination: LatLng; scheduledFor?: string | null; promotionCode?: string },
): Promise<QuoteRow> {
  if (s.role !== Role.CUSTOMER && s.role !== Role.ADMIN) throw AppError.forbidden('Only customers can request quotes.');
  const rules = db.ruleset();

  const route = await getMapsProvider().route(input.pickup, input.destination);
  // Pickup component estimate uses median availability assumption; refined at assignment.
  const pickupEstimateKm = 2.0;
  const discountMinor = input.promotionCode === 'SAFEHOME' ? Math.round(rules.baseFeeMinor / 2) : 0;

  const breakdown = calculatePrice(rules, {
    tripDistanceKm: route.distanceKm,
    pickupDistanceKm: pickupEstimateKm,
    scheduled: Boolean(input.scheduledFor),
    peakActive: false, // demand engine comes later (§10 "if later enabled")
    discountMinor,
  });

  const quote: QuoteRow = {
    id: newId(), customerId: s.userId, breakdown,
    origin: input.pickup, destination: input.destination,
    tripDistanceKm: route.distanceKm,
    scheduledFor: input.scheduledFor ?? null,
    expiresAt: new Date(Date.now() + rules.quoteTtlSeconds * 1000).toISOString(),
    consumed: false,
  };
  db.quotes.set(quote.id, quote);
  db.auditLog(s.userId, 'QUOTE_CREATED', 'quote', quote.id, { total: breakdown.totalMinor });
  return quote;
}

// ── CONFIRM / CREATE TRIP ───────────────────────────────────────────────
export async function confirmQuoteAndCreateTrip(
  s: SessionCtx,
  input: { quoteId: string; vehicleId: string; noteToDriver?: string },
): Promise<TripRow> {
  const quote = db.quotes.get(input.quoteId);
  if (!quote || quote.customerId !== s.userId) throw AppError.notFound('Quote');
  if (quote.consumed) throw AppError.conflict('Quote already used.');
  if (new Date(quote.expiresAt) < new Date()) throw new AppError('QUOTE_EXPIRED', 'Price quote expired — request a new one.', 409);

  const vehicle = db.vehicles.get(input.vehicleId);
  if (!vehicle || vehicle.ownerId !== s.userId) throw AppError.notFound('Vehicle');

  const now = new Date().toISOString();
  const trip: TripRow = {
    id: newId(), customerId: s.userId, driverId: null, vehicleId: vehicle.id,
    status: TripState.REQUESTED,
    origin: { ...quote.origin, label: input.noteToDriver ? undefined : undefined },
    destination: { ...quote.destination },
    scheduledFor: quote.scheduledFor,
    quoteSnapshot: quote.breakdown, // FROZEN — customer-visible price cannot drift after confirmation
    tripDistanceKm: quote.tripDistanceKm, pickupDistanceKm: 0,
    etaSeconds: null, createdAt: now, updatedAt: now, noteToDriver: input.noteToDriver,
  };
  db.trips.set(trip.id, trip);
  quote.consumed = true;

  db.recordTransition(trip.id, null, TripState.REQUESTED, 'CUSTOMER', s.userId, quote.origin, 'Trip requested from confirmed quote.');

  // Authorize payment at booking (capture happens at completion — §11/§12 settlement flow)
  const intent = await getPaymentProvider().authorize(quote.breakdown.totalMinor, quote.breakdown.currency, {
    tripId: trip.id, customerId: s.userId,
  });
  db.payments.set(trip.id, {
    id: newId(), tripId: trip.id, provider: intent.intentId, intentId: intent.intentId,
    amountMinor: quote.breakdown.totalMinor, currency: quote.breakdown.currency,
    status: 'AUTHORIZED', commissionMinor: quote.breakdown.commissionMinor,
    payoutMinor: quote.breakdown.driverPayoutMinor, createdAt: now,
  });

  db.auditLog(s.userId, 'TRIP_CREATED', 'trip', trip.id, { quoteId: quote.id });

  // Immediate trips enter matching now; scheduled trips are activated by the jobs scheduler (Phase 7+).
  if (!trip.scheduledFor) await startSearch(trip.id);
  return trip;
}

/** SYSTEM transition helper — validates via shared state machine BEFORE applying. */
async function applyTransition(
  tripId: string, to: TripStateT, actor: TransitionActor, actorId: string | null, gps: LatLng | null, reason?: string,
): Promise<TripRow> {
  const trip = db.trips.get(tripId);
  if (!trip) throw AppError.notFound('Trip');
  const check = canTransition(trip.status, to, actor);
  if (!check.ok) {
    throw new AppError(check.code!, check.message!, check.code === 'TRIP_TERMINAL_STATE' ? 409 : 422);
  }
  const from = trip.status;
  db.recordTransition(tripId, from, to, actor, actorId, gps, reason);
  publish({ type: 'TripStatusChanged', tripId, from, to, ts: new Date().toISOString() });
  db.auditLog(actorId, `TRIP_${to}`, 'trip', tripId, { from, to, actor });
  return trip;
}

/** Matching entry point: REQUESTED → SEARCHING_DRIVER then dispatch (module boundary kept clean). */
export async function startSearch(tripId: string): Promise<void> {
  await applyTransition(tripId, TripState.SEARCHING_DRIVER, 'SYSTEM', null, null, 'Driver search started.');
  // Lazy import breaks cycles and mirrors how a queue worker would call matching.
  const { runMatching } = await import('../matching/service.js');
  await runMatching(tripId);
}

/** Customer/Driver/Admin explicit transition endpoint logic. */
export async function requestTransition(
  s: SessionCtx, tripId: string, to: TripStateT, gps?: LatLng,
): Promise<TripRow> {
  const trip = db.trips.get(tripId);
  if (!trip) throw AppError.notFound('Trip');
  assertParty(s, trip);

  // Extra domain guards beyond generic state machine (§25 error handling):
  if (to === TripState.TRIP_STARTED) {
    const ho = (db.handovers.get(tripId) ?? []).find((h) => h.phase === 'BEFORE');
    if (!ho || !ho.driverConfirmedAt || !ho.customerConfirmedAt) {
      throw new AppError('HANDOVER_INCOMPLETE', 'Trip cannot start: vehicle handover not fully confirmed by driver AND customer.', 422);
    }
  }
  if (to === TripState.DRIVER_ARRIVED) {
    const d = db.drivers.get(trip.driverId!);
    if (d?.lastLocation && haversineKm(d.lastLocation, trip.origin) > 0.5) {
      throw AppError.validation('You are too far from the pickup location to mark arrival (GPS check).');
    }
  }

  const updated = await applyTransition(tripId, to, s.actor, s.userId, gps ?? null, 'Requested via API.');

  // Side effects per state:
  if (to === TripState.DRIVER_EN_ROUTE && trip.driverId) {
    const r = await getMapsProvider().route(db.drivers.get(trip.driverId)!.lastLocation ?? trip.origin, trip.origin);
    trip.etaSeconds = r.durationSeconds;
    publish({ type: 'Notification', userId: trip.customerId, title: 'Driver on the way', body: `ETA ${Math.max(1, Math.round(r.durationSeconds / 60))} min.` });
  }
  if (to === TripState.HANDOVER_PENDING) publish({ type: 'HandoverPending', tripId });
  if (to === TripState.TRIP_COMPLETED) await completeTripSettlement(trip);
  if (to === TripState.CANCELLED_BY_CUSTOMER || to === TripState.CANCELLED_BY_DRIVER) await releaseDriverAndRefund(trip, to);
  return trip;
}

/** Driver marks arrived etc. also flips BUSY→ONLINE correctly. */
export async function assignDriverToTrip(tripId: string, driverId: string, pickupKm: number): Promise<TripRow> {
  const trip = db.trips.get(tripId);
  if (!trip) throw AppError.notFound('Trip');
  if (!isDriverVerified(driverId)) throw new AppError('DRIVER_NOT_VERIFIED', 'Unverified drivers cannot be assigned.', 403);
  const driver = db.drivers.get(driverId);
  if (!driver) throw AppError.notFound('Driver');
  if (driver.availability !== 'ONLINE') throw new AppError('DRIVER_OFFLINE', 'Driver went offline before accepting.', 409);

  await applyTransition(tripId, TripState.DRIVER_ASSIGNED, 'SYSTEM', driverId, trip.origin, `Driver accepted offer (${pickupKm.toFixed(1)} km to pickup).`);
  trip.driverId = driverId;
  trip.pickupDistanceKm = pickupKm;
  driver.availability = 'BUSY';

  const r = await getMapsProvider().route(driver.lastLocation ?? trip.origin, trip.origin);
  trip.etaSeconds = r.durationSeconds;

  publish({ type: 'DriverAssigned', tripId, driverId, etaSeconds: r.durationSeconds });
  publish({ type: 'Notification', userId: trip.customerId, title: 'Driver found!', body: 'Your designated driver is heading to you.' });
  db.auditLog(driverId, 'DRIVER_ACCEPTED_TRIP', 'trip', tripId, { pickupKm });
  return trip;
}

export function noDriversAvailable(tripId: string): void {
  const trip = db.trips.get(tripId);
  if (!trip) return;
  // Terminal handling proposal §14-R5: keep in SEARCHING? For MVP: notify + leave searchable/cancellable.
  publish({ type: 'NoDriversAvailable', tripId });
  publish({ type: 'Notification', userId: trip.customerId, title: 'Still searching', body: 'No drivers free right now. We keep looking — or cancel anytime.' });
  db.auditLog(null, 'NO_DRIVERS_AVAILABLE', 'trip', tripId);
}

export function getTripForParty(s: SessionCtx, tripId: string): TripRow {
  const trip = db.trips.get(tripId);
  if (!trip) throw AppError.notFound('Trip');
  assertParty(s, trip);
  return trip;
}

function assertParty(s: SessionCtx, trip: TripRow) {
  const ok =
    (s.role === Role.CUSTOMER && trip.customerId === s.userId) ||
    (s.role === Role.DRIVER && trip.driverId === s.userId) ||
    s.role === Role.ADMIN;
  if (!ok) throw AppError.forbidden('Not your trip.'); // row-level ownership (§10 authz)
}

async function completeTripSettlement(trip: TripRow) {
  const pay = db.payments.get(trip.id);
  if (!pay) return;
  const res = await getPaymentProvider().capture(pay.intentId);
  if (!res.ok) {
    pay.status = 'FAILED';
    publish({ type: 'Notification', userId: trip.customerId, title: 'Payment failed', body: 'Update your payment method to settle this trip.' });
    db.auditLog(null, 'PAYMENT_CAPTURE_FAILED', 'payment', pay.id, { tripId: trip.id });
    return;
  }
  pay.status = 'CAPTURED';
  // Payout ledger row (driver share from frozen snapshot — §11)
  db.auditLog(trip.driverId, 'DRIVER_PAYOUT_RECORDED', 'payout', newId(), { tripId: trip.id, amountMinor: pay.payoutMinor });
  publish({ type: 'Notification', userId: trip.customerId, title: 'Trip complete', body: 'Thanks for riding safe. Rate your driver!' });
  if (trip.driverId) {
    const d = db.drivers.get(trip.driverId);
    if (d) d.availability = 'ONLINE'; // freed for next job
  }
}

async function releaseDriverAndRefund(trip: TripRow, to: TripStateT) {
  if (trip.driverId) {
    const d = db.drivers.get(trip.driverId);
    if (d && d.availability === 'BUSY') d.availability = 'ONLINE';
  }
  const pay = db.payments.get(trip.id);
  if (pay && pay.status === 'AUTHORIZED') {
    // Cancellation fee policy: charge configurable fee only past free window (here: after DRIVER_ARRIVED).
    const feeApplies = to === TripState.CANCELLED_BY_CUSTOMER &&
      ([TripState.DRIVER_ARRIVED, TripState.HANDOVER_PENDING, TripState.HANDOVER_CONFIRMED] as readonly TripStateT[]).includes(trip.status);
    const rules = db.ruleset();
    const cancelFee = feeApplies ? Math.round(rules.baseFeeMinor * 0.5) : 0; // rule value from data-derived base
    const refundable = pay.amountMinor - cancelFee;
    if (refundable > 0) await getPaymentProvider().refund(pay.intentId, refundable);
    pay.status = cancelFee > 0 ? 'PARTIALLY_REFUNDED' : 'REFUNDED';
    db.auditLog(trip.customerId, 'PAYMENT_CANCEL_SETTLED', 'payment', pay.id, { cancelFee });
  }
}

/** Handover module calls this once BOTH confirmations exist → SYSTEM transition. */
export async function handoverFullyConfirmed(tripId: string): Promise<void> {
  await applyTransition(tripId, TripState.HANDOVER_CONFIRMED, 'SYSTEM', null, null, 'Driver + customer both confirmed handover record.');
  publish({ type: 'HandoverConfirmed', tripId });
}

export function listTripsForUser(s: SessionCtx, limit = 20): TripRow[] {
  return [...db.trips.values()]
    .filter((t) => t.customerId === s.userId || t.driverId === s.userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function activeTripForDriver(driverId: string): TripRow | null {
  for (const t of db.trips.values()) {
    if (t.driverId === driverId && isActiveTripState(t.status)) return t;
  }
  return null;
}
