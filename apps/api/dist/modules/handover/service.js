/**
 * VEHICLE HANDOVER SERVICE (brief §7) — the trust core of the product.
 * BEFORE-trip record: identification, odometer/fuel/battery, damage notes,
 * photo keys (uploaded via presigned URLs by driver app), GPS + timestamps,
 * DUAL confirmation (driver AND customer). Only after both confirm does the
 * trips service perform the SYSTEM transition HANDOVER_PENDING → HANDOVER_CONFIRMED,
 * which is the ONLY door into TRIP_STARTED (state machine guarantees it).
 */
import { HandoverPhase, TripState } from '@testmobil/shared';
import { db, newId } from '../../db/store.js';
import { AppError } from '../../errors.js';
import { requestTransition, handoverFullyConfirmed, getTripForParty } from '../trips/service.js';
/** Driver begins inspection at pickup (also triggers DRIVER_ARRIVED→HANDOVER_PENDING). */
export async function startBeforeHandover(s, tripId, input) {
    if (s.role !== 'DRIVER')
        throw AppError.forbidden('Only the assigned driver records the handover.');
    const trip = getTripForParty(s, tripId);
    if (trip.status === TripState.DRIVER_ARRIVED) {
        await requestTransition(s, tripId, TripState.HANDOVER_PENDING, input.gps);
    }
    else if (trip.status !== TripState.HANDOVER_PENDING) {
        throw AppError.conflict(`Handover only possible at arrival; trip is ${trip.status}.`);
    }
    validateCondition(input);
    const existing = (db.handovers.get(tripId) ?? []).find((h) => h.phase === HandoverPhase.BEFORE && !h.driverConfirmedAt);
    const vehicle = trip.vehicleId ? db.vehicles.get(trip.vehicleId) : null;
    if (!vehicle)
        throw AppError.notFound('Vehicle');
    const row = existing ?? {
        id: newId(), tripId, phase: HandoverPhase.BEFORE,
        odometerKm: null, fuelLevelPercent: null, batteryLevelPercent: null,
        damageNotes: [], photoKeys: [], gps: input.gps,
        driverConfirmedAt: null, customerConfirmedAt: null, createdAt: new Date().toISOString(),
    };
    row.odometerKm = input.odometerKm ?? row.odometerKm;
    row.fuelLevelPercent = input.fuelLevelPercent ?? row.fuelLevelPercent;
    row.batteryLevelPercent = input.batteryLevelPercent ?? row.batteryLevelPercent;
    row.damageNotes = (input.damageNotes ?? []).map((d) => ({ ...d, photoKeys: [] }));
    row.photoKeys = [...new Set([...(row.photoKeys ?? []), ...(input.photoKeys ?? [])])];
    row.gps = input.gps;
    if (!existing)
        (db.handovers.get(tripId) ?? db.handovers.set(tripId, []).get(tripId)).push(row);
    db.auditLog(s.userId, 'HANDOVER_RECORDED', 'handover', row.id, { tripId, photos: row.photoKeys.length });
    return row;
}
/** Driver signs the BEFORE record. */
export async function driverConfirmHandover(s, handoverId) {
    const h = mustFind(handoverId);
    const trip = db.trips.get(h.tripId);
    if (s.role !== 'DRIVER' || trip.driverId !== s.userId)
        throw AppError.forbidden('Not your handover.');
    if (h.customerConfirmedAt && h.driverConfirmedAt)
        throw AppError.conflict('Already fully confirmed.');
    h.driverConfirmedAt = new Date().toISOString();
    db.auditLog(s.userId, 'HANDOVER_DRIVER_CONFIRMED', 'handover', h.id, { tripId: h.tripId });
    await maybeFinalize(h);
    return h;
}
/** Customer reviews evidence and signs. Plain-language consent (§14-R3 impaired-capacity care). */
export async function customerConfirmHandover(s, handoverId) {
    const h = mustFind(handoverId);
    const trip = db.trips.get(h.tripId);
    if (s.role !== 'CUSTOMER' || trip.customerId !== s.userId)
        throw AppError.forbidden('Not your handover.');
    if (!h.driverConfirmedAt)
        throw AppError.conflict('Driver must complete and sign the inspection first.');
    h.customerConfirmedAt = new Date().toISOString();
    db.auditLog(s.userId, 'HANDOVER_CUSTOMER_CONFIRMED', 'handover', h.id, { tripId: h.tripId });
    await maybeFinalize(h);
    return h;
}
/** Customer rejects handover → cancel path (state machine allows HANDOVER_PENDING→CANCELLED_BY_CUSTOMER). */
export async function customerRejectHandover(s, handoverId, reason) {
    const h = mustFind(handoverId);
    if (s.role !== 'CUSTOMER')
        throw AppError.forbidden('Only the customer can reject a handover.');
    db.auditLog(s.userId, 'HANDOVER_REJECTED', 'handover', h.id, { reason });
    await requestTransition(s, h.tripId, TripState.CANCELLED_BY_CUSTOMER, h.gps);
}
async function maybeFinalize(h) {
    if (h.driverConfirmedAt && h.customerConfirmedAt && h.phase === HandoverPhase.BEFORE) {
        const trip = db.trips.get(h.tripId);
        if (trip.status === TripState.HANDOVER_PENDING)
            await handoverFullyConfirmed(h.tripId);
    }
}
function mustFind(id) {
    for (const list of db.handovers.values()) {
        const h = list.find((x) => x.id === id);
        if (h)
            return h;
    }
    throw AppError.notFound('Handover record');
}
function validateCondition(i) {
    const pct = (v) => v === undefined || v === null || (v >= 0 && v <= 100);
    if (!pct(i.fuelLevelPercent) || !pct(i.batteryLevelPercent))
        throw AppError.validation('Fuel/battery level must be 0–100%.');
    if (i.odometerKm !== undefined && (i.odometerKm < 0 || i.odometerKm > 5_000_000))
        throw AppError.validation('Implausible odometer value.');
    for (const d of i.damageNotes ?? []) {
        if (!d.location?.trim() || !d.description?.trim())
            throw AppError.validation('Damage entries need location and description.');
    }
}
/** AFTER-trip optional final inspection at destination (closes evidence loop §7). */
export async function recordAfterInspection(s, tripId, input) {
    const trip = getTripForParty(s, tripId);
    if (trip.status !== TripState.ARRIVING && trip.status !== TripState.TRIP_STARTED) {
        throw AppError.conflict('Final inspection only during/just before trip end.');
    }
    validateCondition(input);
    const row = {
        id: newId(), tripId, phase: HandoverPhase.AFTER,
        odometerKm: input.odometerKm ?? null, fuelLevelPercent: input.fuelLevelPercent ?? null,
        batteryLevelPercent: input.batteryLevelPercent ?? null,
        damageNotes: (input.damageNotes ?? []).map((d) => ({ ...d, photoKeys: [] })),
        photoKeys: input.photoKeys ?? [], gps: input.gps,
        driverConfirmedAt: new Date().toISOString(), customerConfirmedAt: null, createdAt: new Date().toISOString(),
    };
    (db.handovers.get(tripId) ?? db.handovers.set(tripId, []).get(tripId)).push(row);
    db.auditLog(s.userId, 'AFTER_INSPECTION_RECORDED', 'handover', row.id, { tripId });
    return row;
}
export function getHandovers(tripId) {
    return db.handovers.get(tripId) ?? [];
}
