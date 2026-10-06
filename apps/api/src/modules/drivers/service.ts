/**
 * DRIVER SERVICE — availability control, presence pings (battery-conscious §8),
 * verification status, ratings aggregation, earnings view.
 */
import { DriverAvailability, isActiveTripState, type LatLng } from '@testmobil/shared';
import { db, newId } from '../../db/store.js';
import { AppError } from '../../errors.js';
import { isDriverVerified } from '../auth/service.js';
import { activeTripForDriver } from '../trips/service.js';

export function setAvailability(s: { userId: string }, want: 'ONLINE' | 'OFFLINE') {
  const d = db.drivers.get(s.userId);
  if (!d) throw AppError.notFound('Driver profile');
  if (want === 'ONLINE') {
    if (!isDriverVerified(s.userId)) throw new AppError('DRIVER_NOT_VERIFIED', 'Complete identity & licence verification before going online.', 403);
    const busy = activeTripForDriver(s.userId);
    if (busy && isActiveTripState(busy.status)) throw AppError.conflict('You have an active trip.');
    if (!d.lastLocation) throw AppError.validation('Share your location once before going online.');
    d.availability = DriverAvailability.ONLINE;
  } else {
    const busy = activeTripForDriver(s.userId);
    if (busy) throw AppError.conflict('Finish or cancel the active trip before going offline.');
    d.availability = DriverAvailability.OFFLINE;
  }
  db.auditLog(s.userId, `DRIVER_${want}`, 'driver', s.userId);
}

/** Presence ping (~30s cadence from app while ONLINE; Redis TTL key in prod). */
export function pingLocation(s: { userId: string }, gps: LatLng) {
  const d = db.drivers.get(s.userId);
  if (!d) throw AppError.notFound('Driver profile');
  d.lastLocation = gps;
  d.lastSeenAt = new Date().toISOString();
}

export function driverDashboard(s: { userId: string }) {
  const d = db.drivers.get(s.userId);
  if (!d) throw AppError.notFound('Driver profile');
  const verifications = db.verifications.filter((v) => v.driverId === s.userId);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  let todayEarnings = 0;
  for (const p of db.payments.values()) {
    const t = db.trips.get(p.tripId);
    if (t?.driverId === s.userId && p.status === 'CAPTURED' && Date.parse(p.createdAt) >= todayStart.getTime()) {
      todayEarnings += p.payoutMinor;
    }
  }
  return {
    availability: d.availability,
    verified: isDriverVerified(s.userId),
    verifications: verifications.map((v) => ({ type: v.type, status: v.status, expiresAt: v.expiresAt })),
    canDriveManual: d.canDriveManual,
    ratingAvg: d.ratingCount ? Math.round((d.ratingSum / d.ratingCount) * 10) / 10 : null,
    ratingCount: d.ratingCount,
    todayEarningsMinor: todayEarnings,
    activeTrip: activeTripForDriver(s.userId),
    pendingOffers: db.offers.filter((o) => o.driverId === s.userId && o.status === 'PENDING'),
  };
}

/** Customer rates driver after completion (§14). One rating per trip direction. */
export function rateDriver(s: { userId: string; role: string }, tripId: string, score: number, comment?: string) {
  if (score < 1 || score > 5) throw AppError.validation('Score must be 1–5.');
  const trip = db.trips.get(tripId);
  if (!trip) throw AppError.notFound('Trip');
  if (s.role !== 'CUSTOMER' || trip.customerId !== s.userId) throw AppError.forbidden('Not your trip to rate.');
  if (trip.status !== 'TRIP_COMPLETED') throw AppError.conflict('Rate only after a completed trip.');
  const key = `rating:${tripId}:CUST_TO_DRV`;
  if ((db as any)[key]) throw AppError.conflict('Already rated this trip.');
  (db as any)[key] = true;
  const d = db.drivers.get(trip.driverId!);
  if (d) { d.ratingSum += score; d.ratingCount += 1; }
  db.auditLog(s.userId, 'DRIVER_RATED', 'trip', tripId, { score, comment: comment?.slice(0, 500) });
}

/** Admin approves/rejects one verification item (§4B, Phase 12 surface but needed to unblock MVP flow). */
export function adminReviewVerification(adminId: string, verificationId: string, approve: boolean) {
  const v = db.verifications.find((x) => x.id === verificationId);
  if (!v) throw AppError.notFound('Verification');
  v.status = approve ? 'VERIFIED' : 'REJECTED';
  v.reviewedBy = adminId;
  v.reviewedAt = new Date().toISOString();
  db.auditLog(adminId, approve ? 'VERIFICATION_APPROVED' : 'VERIFICATION_REJECTED', 'verification', v.id, { driverId: v.driverId });
  // notify driver
  import('../realtime/events.js').then(({ publish }) =>
    publish({ type: 'Notification', userId: v.driverId, title: approve ? 'You are verified ✅' : 'Verification rejected', body: approve ? 'You can go online now.' : 'Please re-upload valid documents.' }));
}

export function listPendingVerifications() {
  return db.verifications.filter((v) => v.status === 'PENDING');
}
