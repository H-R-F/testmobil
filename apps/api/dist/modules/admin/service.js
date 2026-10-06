/**
 * ADMIN SERVICE — ops dashboard aggregates (§16) + account suspension.
 */
import { db } from '../../db/store.js';
import { AppError } from '../../errors.js';
import { isActiveTripState } from '@testmobil/shared';
export function adminStats(adminId) {
    const trips = [...db.trips.values()];
    const drivers = [...db.drivers.values()];
    const active = trips.filter((t) => isActiveTripState(t.status));
    const completed = trips.filter((t) => t.status === 'TRIP_COMPLETED');
    const revenueMinor = completed.reduce((s, t) => s + (db.payments.get(t.id)?.commissionMinor ?? 0), 0);
    return {
        activeTrips: active.length,
        onlineDrivers: drivers.filter((d) => d.availability === 'ONLINE').length,
        busyDrivers: drivers.filter((d) => d.availability === 'BUSY').length,
        pendingVerifications: db.verifications.filter((v) => v.status === 'PENDING').length,
        openIncidents: db.incidents.filter((i) => i.status === 'OPEN').length,
        completedTrips: completed.length,
        platformRevenueMinor: revenueMinor,
    };
}
export function adminListTrips(filter) {
    return [...db.trips.values()]
        .filter((t) => !filter?.status || t.status === filter.status)
        .filter((t) => !filter?.customerId || t.customerId === filter.customerId)
        .filter((t) => !filter?.driverId || t.driverId === filter.driverId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);
}
export function adminTripTimeline(tripId) {
    if (!db.trips.has(tripId))
        throw AppError.notFound('Trip');
    return db.statusHistory.filter((h) => h.tripId === tripId);
}
export function adminSetUserStatus(adminId, userId, status) {
    const u = db.users.get(userId);
    if (!u)
        throw AppError.notFound('User');
    if (u.role === 'ADMIN' && status === 'SUSPENDED')
        throw AppError.forbidden('Admins cannot be suspended via this endpoint.');
    u.status = status;
    if (status === 'SUSPENDED') {
        const d = db.drivers.get(userId);
        if (d)
            d.availability = 'OFFLINE'; // safety: suspended driver leaves the pool immediately
    }
    db.auditLog(adminId, `USER_${status}`, 'user', userId, { previousRole: u.role });
}
export function adminUpdatePricingRule(adminId, key, value) {
    const rules = db.ruleset();
    const map = {
        BASE_FEE: 'baseFeeMinor', PER_KM_FEE: 'perKmFeeMinor', PICKUP_FEE_PER_KM: 'pickupFeePerKmMinor',
        PICKUP_MIN_FEE: 'pickupMinFeeMinor', SCHEDULED_BOOKING_FEE: 'scheduledBookingFeeMinor',
        PEAK_MULTIPLIER: 'peakMultiplier', PLATFORM_COMMISSION_PERCENT: 'platformCommissionPercent',
        QUOTE_TTL_SECONDS: 'quoteTtlSeconds',
    };
    const field = map[key];
    if (!field)
        throw AppError.validation(`Unknown pricing rule ${key}.`);
    if (!Number.isFinite(value) || value < 0)
        throw AppError.validation('Rule value must be a non-negative number.');
    rules[field] = value;
    db.pricingRulesets.set('default', rules);
    db.auditLog(adminId, 'PRICING_RULE_UPDATED', 'pricing_rule', key, { value });
}
