import { describe, it, expect } from 'vitest';
import { calculatePrice, formatMoney } from '../src/pricing.js';
const rules = {
    currency: 'EUR',
    baseFeeMinor: 490,
    perKmFeeMinor: 150,
    pickupFeePerKmMinor: 100,
    pickupMinFeeMinor: 200,
    scheduledBookingFeeMinor: 300,
    peakMultiplier: 1.25,
    platformCommissionPercent: 20,
    quoteTtlSeconds: 300,
};
describe('pricing engine (brief §10/§11)', () => {
    it('computes itemized total = base + trip km + pickup component', () => {
        const b = calculatePrice(rules, { tripDistanceKm: 10, pickupDistanceKm: 2, scheduled: false, peakActive: false });
        // 490 + 1500 + max(200, 200)=200 → 2190
        expect(b.totalMinor).toBe(2190);
        expect(b.items.map((i) => i.key)).toEqual(['BASE_FEE', 'TRIP_DISTANCE_FEE', 'PICKUP_COMPONENT']);
        expect(b.commissionMinor).toBe(438); // 20% rounded
        expect(b.driverPayoutMinor).toBe(b.totalMinor - b.commissionMinor);
    });
    it('pickup minimum applies but zero-pickup costs nothing', () => {
        expect(calculatePrice(rules, { tripDistanceKm: 1, pickupDistanceKm: 0.5, scheduled: false, peakActive: false })
            .items.find((i) => i.key === 'PICKUP_COMPONENT').amountMinor).toBe(200);
        expect(calculatePrice(rules, { tripDistanceKm: 1, pickupDistanceKm: 0, scheduled: false, peakActive: false })
            .items.find((i) => i.key === 'PICKUP_COMPONENT').amountMinor).toBe(0);
    });
    it('scheduled fee and peak multiplier stack correctly', () => {
        const b = calculatePrice(rules, { tripDistanceKm: 10, pickupDistanceKm: 2, scheduled: true, peakActive: true });
        // subtotal before peak: 490+1500+200+300=2490; peak +25% = 623 → 3113
        expect(b.subtotalMinor).toBe(3113);
        expect(b.totalMinor).toBe(3113);
    });
    it('discount never makes total negative and commission uses final total', () => {
        const b = calculatePrice(rules, { tripDistanceKm: 1, pickupDistanceKm: 0, scheduled: false, peakActive: false, discountMinor: 99999 });
        expect(b.totalMinor).toBe(0);
        expect(b.commissionMinor).toBe(0);
        expect(b.driverPayoutMinor).toBe(0);
    });
    it('rejects negative distances (input validation)', () => {
        expect(() => calculatePrice(rules, { tripDistanceKm: -1, pickupDistanceKm: 0, scheduled: false, peakActive: false })).toThrow();
    });
    it('formats money in minor units', () => {
        expect(formatMoney(2190, 'EUR')).toBe('€21.90');
    });
    it('property: commission + payout == total for many inputs', () => {
        for (let km = 0; km <= 50; km += 3) {
            for (const pk of [0, 1.7, 5]) {
                const b = calculatePrice(rules, { tripDistanceKm: km, pickupDistanceKm: pk, scheduled: km % 2 === 0, peakActive: km > 30 });
                expect(b.commissionMinor + b.driverPayoutMinor).toBe(b.totalMinor);
                expect(b.totalMinor).toBeGreaterThanOrEqual(0);
            }
        }
    });
});
