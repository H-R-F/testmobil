/**
 * IN-MEMORY REPOSITORY — dev/test data layer implementing the SAME interfaces the
 * Postgres/Drizzle repositories will implement in Phase 3+ (proposal §4 module
 * convention: routes → service → repository). Swapping this out later touches no
 * business logic. NOT frontend mock logic: all rules are enforced server-side here.
 */
import { ulid } from 'ulidx';
export const newId = () => ulid().toLowerCase();
export class Db {
    users = new Map();
    emailIndex = new Map();
    customers = new Map();
    drivers = new Map();
    verifications = [];
    vehicles = new Map();
    trips = new Map();
    statusHistory = [];
    handovers = new Map(); // by tripId
    quotes = new Map();
    offers = [];
    payments = new Map();
    incidents = [];
    audit = [];
    zones = [];
    pricingRulesets = new Map(); // zoneId|default → ruleset (§10: DB-configured)
    constructor() {
        // Seed defaults behave like pricing_rules table rows — engine reads them; values live in data, not code paths.
        this.pricingRulesets.set('default', {
            currency: 'EUR', baseFeeMinor: 490, perKmFeeMinor: 150, pickupFeePerKmMinor: 100,
            pickupMinFeeMinor: 200, scheduledBookingFeeMinor: 300, peakMultiplier: 1,
            platformCommissionPercent: 20, quoteTtlSeconds: 300,
        });
    }
    ruleset() { return this.pricingRulesets.get('default'); }
    auditLog(actorId, action, entity, entityId, meta) {
        this.audit.push({ id: newId(), actorId, action, entity, entityId, ts: new Date().toISOString(), meta });
    }
    recordTransition(tripId, from, to, actor, actorId, gps, reason) {
        this.statusHistory.push({ id: newId(), tripId, fromState: from, toState: to, actor, actorId, gps, ts: new Date().toISOString(), reason });
        const t = this.trips.get(tripId);
        if (t) {
            t.status = to;
            t.updatedAt = new Date().toISOString();
        }
    }
}
export const db = new Db();
/** Reset between tests (fresh maps + fresh seeded rulesets). */
export function resetDb() {
    const fresh = new Db();
    Object.assign(db, fresh);
}
