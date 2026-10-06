import { describe, it, expect } from 'vitest';
import { TripState, ALL_TRIP_STATES, TERMINAL_STATES, TRANSITIONS, canTransition, allowedTransitionsFrom, isActiveTripState, } from '../src/trip-state-machine.js';
const HAPPY_PATH = [
    TripState.REQUESTED, TripState.SEARCHING_DRIVER, TripState.DRIVER_ASSIGNED,
    TripState.DRIVER_EN_ROUTE, TripState.DRIVER_ARRIVED, TripState.HANDOVER_PENDING,
    TripState.HANDOVER_CONFIRMED, TripState.TRIP_STARTED, TripState.ARRIVING, TripState.TRIP_COMPLETED,
];
describe('trip state machine (brief §8)', () => {
    it('accepts the complete happy path with correct actors', () => {
        const actors = {
            REQUESTED: 'SYSTEM', SEARCHING_DRIVER: 'SYSTEM', DRIVER_ASSIGNED: 'DRIVER',
            DRIVER_EN_ROUTE: 'DRIVER', DRIVER_ARRIVED: 'SYSTEM', HANDOVER_PENDING: 'SYSTEM',
            HANDOVER_CONFIRMED: 'DRIVER', TRIP_STARTED: 'SYSTEM', ARRIVING: 'DRIVER',
        };
        for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
            const from = HAPPY_PATH[i], to = HAPPY_PATH[i + 1];
            const res = canTransition(from, to, actors[from] ?? 'SYSTEM');
            expect(res.ok, `${from}→${to}`).toBe(true);
        }
    });
    it('TRIP_STARTED is ONLY reachable via HANDOVER_CONFIRMED (handover gate §7)', () => {
        for (const s of ALL_TRIP_STATES) {
            if (s === TripState.HANDOVER_CONFIRMED)
                continue;
            const res = canTransition(s, TripState.TRIP_STARTED, 'DRIVER');
            expect(res.ok, `illegal start from ${s}`).toBe(false);
        }
    });
    it('HANDOVER_CONFIRMED requires SYSTEM (i.e. dual driver+customer confirmation recorded)', () => {
        expect(canTransition(TripState.HANDOVER_PENDING, TripState.HANDOVER_CONFIRMED, 'DRIVER').ok).toBe(false);
        expect(canTransition(TripState.HANDOVER_PENDING, TripState.HANDOVER_CONFIRMED, 'CUSTOMER').ok).toBe(false);
        expect(canTransition(TripState.HANDOVER_PENDING, TripState.HANDOVER_CONFIRMED, 'SYSTEM').ok).toBe(true);
    });
    it('rejects every undefined transition pair (exhaustive matrix sanity)', () => {
        let defined = 0;
        for (const from of ALL_TRIP_STATES) {
            for (const to of ALL_TRIP_STATES) {
                const ok = canTransition(from, to, 'ADMIN').ok || canTransition(from, to, 'SYSTEM').ok
                    || canTransition(from, to, 'DRIVER').ok || canTransition(from, to, 'CUSTOMER').ok;
                const declared = (TRANSITIONS[from] ?? []).some((r) => r.to === to);
                expect(ok).toBe(declared);
                if (declared)
                    defined++;
            }
        }
        expect(defined).toBeGreaterThan(HAPPY_PATH.length); // edge states exist too
    });
    it('terminal states allow no transitions at all', () => {
        for (const t of TERMINAL_STATES) {
            expect(allowedTransitionsFrom(t)).toEqual([]);
            for (const to of ALL_TRIP_STATES) {
                expect(canTransition(t, to, 'ADMIN').ok).toBe(false);
            }
        }
    });
    it('actor enforcement: customer cannot mark arrival, driver cannot cancel-as-customer', () => {
        expect(canTransition(TripState.DRIVER_EN_ROUTE, TripState.DRIVER_ARRIVED, 'CUSTOMER').ok).toBe(false);
        expect(canTransition(TripState.DRIVER_EN_ROUTE, TripState.CANCELLED_BY_CUSTOMER, 'DRIVER').ok).toBe(false);
        expect(canTransition(TripState.DRIVER_EN_ROUTE, TripState.CANCELLED_BY_CUSTOMER, 'CUSTOMER').ok).toBe(true);
    });
    it('SOS is possible during any active driving phase', () => {
        for (const s of [TripState.TRIP_STARTED, TripState.ARRIVING]) {
            expect(canTransition(s, TripState.EMERGENCY, 'CUSTOMER').ok).toBe(true);
            expect(canTransition(s, TripState.EMERGENCY, 'DRIVER').ok).toBe(true);
        }
        // not before a driver is even assigned
        expect(canTransition(TripState.REQUESTED, TripState.EMERGENCY, 'CUSTOMER').ok).toBe(false);
    });
    it('isActiveTripState marks exactly the committed-driver window', () => {
        const active = ALL_TRIP_STATES.filter(isActiveTripState);
        expect(active).toContain(TripState.DRIVER_ASSIGNED);
        expect(active).toContain(TripState.TRIP_STARTED);
        expect(active).toContain(TripState.EMERGENCY);
        expect(active).not.toContain(TripState.SEARCHING_DRIVER);
        expect(active).not.toContain(TripState.TRIP_COMPLETED);
        expect(active).not.toContain(TripState.CUSTOMER_NO_SHOW);
    });
});
