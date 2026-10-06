/**
 * MATCHING ENGINE (brief §9) — decoupled from UI and from trip transport layer.
 * Strategy per proposal: eligible pool → geo-rank → offer cascade with TTL.
 * Designed so a smarter dispatcher (batch matching/ML ETA) can replace `rankCandidates`.
 */
import { haversineKm, calculatePrice } from '@testmobil/shared';
import { db, newId } from '../../db/store.js';
import { isDriverVerified } from '../auth/service.js';
import { publish } from '../realtime/events.js';
import { assignDriverToTrip, noDriversAvailable } from '../trips/service.js';
const OFFER_TTL_SECONDS = 30; // per-driver decision window
const MAX_OFFER_ROUNDS = 5; // offer up to N closest drivers sequentially
export const PRESENCE_STALE_SECONDS = 60; // ping older than this ⇒ treated offline (§8 battery design)
/** Eligibility filter (§9 list): verified + ONLINE + fresh presence + not BUSY + location known. */
export function eligibleDrivers(pickup, requireManual) {
    const now = Date.now();
    const out = [];
    for (const d of db.drivers.values()) {
        if (d.availability !== 'ONLINE')
            continue;
        if (!d.lastLocation)
            continue;
        if (!d.lastSeenAt || now - Date.parse(d.lastSeenAt) > PRESENCE_STALE_SECONDS * 1000)
            continue;
        if (!isDriverVerified(d.userId))
            continue; // safety gate: never offer to unverified
        if (requireManual && !d.canDriveManual)
            continue; // customer requirement capability match
        out.push({ driverId: d.userId, lastLocation: d.lastLocation, canDriveManual: d.canDriveManual });
    }
    return out;
}
/** Rank by straight-line distance (PostGIS KNN in prod). Pluggable point for future algorithms. */
export function rankCandidates(pickup, pool) {
    return pool
        .map((c) => {
        const distanceKm = haversineKm(c.lastLocation, pickup);
        // score blends proximity with rating quality (tiny weight — mostly nearest-first)
        const prof = db.drivers.get(c.driverId);
        const avg = prof.ratingCount ? prof.ratingSum / prof.ratingCount : 4.5;
        const score = distanceKm + Math.max(0, 4.7 - avg) * 0.2;
        return { driverId: c.driverId, distanceKm, score };
    })
        .sort((a, b) => a.score - b.score);
}
/**
 * Offer cascade: push offers over the event bus (WS delivers to driver apps).
 * Acceptance comes via acceptOffer(); expiry handled by sweepExpiredOffers() job.
 * MVP simplification: we create the first round of PENDING offers; the first driver
 * to accept wins (race-safe check inside acceptOffer).
 */
export async function runMatching(tripId) {
    const trip = db.trips.get(tripId);
    if (!trip || trip.status !== 'SEARCHING_DRIVER')
        return;
    const vehicle = trip.vehicleId ? db.vehicles.get(trip.vehicleId) : undefined;
    const requireManual = vehicle?.transmission === 'MANUAL';
    const pool = eligibleDrivers(trip.origin, requireManual);
    const ranked = rankCandidates(trip.origin, pool).slice(0, MAX_OFFER_ROUNDS);
    if (ranked.length === 0) {
        noDriversAvailable(tripId);
        return;
    }
    const rules = db.ruleset();
    for (const cand of ranked) {
        // estimated payout shown up-front (transparency §10): recompute price at THIS pickup distance, driver share only
        const b = calculatePrice(rules, {
            tripDistanceKm: trip.tripDistanceKm,
            pickupDistanceKm: cand.distanceKm,
            scheduled: Boolean(trip.scheduledFor),
            peakActive: false,
        });
        const offer = {
            id: newId(), tripId, driverId: cand.driverId,
            distanceToPickupKm: Math.round(cand.distanceKm * 10) / 10,
            estimatedPayoutMinor: b.driverPayoutMinor,
            expiresAt: new Date(Date.now() + OFFER_TTL_SECONDS * 1000).toISOString(),
            status: 'PENDING', createdAt: new Date().toISOString(),
        };
        db.offers.push(offer);
        publish({ type: 'TripOffered', driverId: cand.driverId, tripId, offerId: offer.id, expiresAt: offer.expiresAt });
    }
    db.auditLog(null, 'MATCHING_OFFERS_SENT', 'trip', tripId, { count: ranked.length });
}
/** Driver accepts an offer — race-safe: only one accepted offer may exist per trip. */
export async function acceptOffer(s, offerId) {
    const offer = db.offers.find((o) => o.id === offerId);
    if (!offer || offer.driverId !== s.userId)
        throw Object.assign(new Error('Offer not found.'), { code: 'NOT_FOUND', httpStatus: 404 });
    if (offer.status !== 'PENDING')
        throw Object.assign(new Error('Offer no longer available.'), { code: 'CONFLICT', httpStatus: 409 });
    if (new Date(offer.expiresAt) < new Date()) {
        offer.status = 'EXPIRED';
        throw Object.assign(new Error('Offer expired.'), { code: 'CONFLICT', httpStatus: 409 });
    }
    const trip = db.trips.get(offer.tripId);
    if (!trip || trip.status !== 'SEARCHING_DRIVER') {
        offer.status = 'EXPIRED';
        throw Object.assign(new Error('This trip was already taken or cancelled.'), { code: 'CONFLICT', httpStatus: 409 });
    }
    offer.status = 'ACCEPTED';
    // decline all sibling pending offers (other drivers see it vanish immediately)
    for (const o of db.offers)
        if (o.tripId === trip.id && o.status === 'PENDING' && o.id !== offer.id)
            o.status = 'DECLINED';
    await assignDriverToTrip(trip.id, offer.driverId, offer.distanceToPickupKm);
}
export function declineOffer(s, offerId) {
    const offer = db.offers.find((o) => o.id === offerId && o.driverId === s.userId);
    if (!offer || offer.status !== 'PENDING')
        return;
    offer.status = 'DECLINED';
    publish({ type: 'OfferExpired', driverId: s.userId, tripId: offer.tripId, offerId });
}
/** Cron: expire stale offers; if none remain and nobody accepted, re-run matching once then give notice. */
export async function sweepExpiredOffers() {
    const now = Date.now();
    const tripsToRecheck = new Set();
    for (const o of db.offers) {
        if (o.status === 'PENDING' && Date.parse(o.expiresAt) < now) {
            o.status = 'EXPIRED';
            publish({ type: 'OfferExpired', driverId: o.driverId, tripId: o.tripId, offerId: o.id });
            tripsToRecheck.add(o.tripId);
        }
    }
    for (const tripId of tripsToRecheck) {
        const trip = db.trips.get(tripId);
        if (!trip || trip.status !== 'SEARCHING_DRIVER')
            continue;
        const stillPending = db.offers.some((o) => o.tripId === tripId && o.status === 'PENDING');
        if (!stillPending)
            await runMatching(tripId); // widen/re-offer loop; ends in noDriversAvailable when pool empty
    }
}
