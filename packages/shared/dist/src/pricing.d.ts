/**
 * Pricing model types + PURE calculation engine (brief §10).
 * Rule VALUES are never hardcoded here — they arrive as PricingRule rows
 * from the DB (configurable by admin). This file defines the shape and math.
 * All money is integer minor units (cents) to avoid float drift (§12).
 */
export declare const Currency: {
    readonly EUR: "EUR";
    readonly USD: "USD";
    readonly GBP: "GBP";
};
export type CurrencyT = (typeof Currency)[keyof typeof Currency];
/** Configurable rule kinds stored in `pricing_rules` table. */
export declare const PricingRuleKey: {
    readonly BASE_FEE: "BASE_FEE";
    readonly PER_KM_FEE: "PER_KM_FEE";
    readonly PICKUP_FEE_PER_KM: "PICKUP_FEE_PER_KM";
    readonly PICKUP_MIN_FEE: "PICKUP_MIN_FEE";
    readonly SCHEDULED_BOOKING_FEE: "SCHEDULED_BOOKING_FEE";
    readonly CANCELLATION_FEE: "CANCELLATION_FEE";
    readonly PEAK_MULTIPLIER: "PEAK_MULTIPLIER";
    readonly PLATFORM_COMMISSION_PERCENT: "PLATFORM_COMMISSION_PERCENT";
    readonly QUOTE_TTL_SECONDS: "QUOTE_TTL_SECONDS";
};
export type PricingRuleKeyT = (typeof PricingRuleKey)[keyof typeof PricingRuleKey];
export interface PricingRuleset {
    currency: CurrencyT;
    baseFeeMinor: number;
    perKmFeeMinor: number;
    pickupFeePerKmMinor: number;
    pickupMinFeeMinor: number;
    scheduledBookingFeeMinor: number;
    peakMultiplier: number;
    platformCommissionPercent: number;
    quoteTtlSeconds: number;
}
export interface PriceInput {
    tripDistanceKm: number;
    pickupDistanceKm: number;
    scheduled: boolean;
    peakActive: boolean;
    /** discount in minor units (from promotion); clamped so total >= 0 */
    discountMinor?: number;
}
export interface PriceLineItem {
    key: string;
    label: string;
    amountMinor: number;
}
export interface PriceBreakdown {
    currency: CurrencyT;
    items: PriceLineItem[];
    subtotalMinor: number;
    totalMinor: number;
    /** settlement split snapshot (business model §11) */
    commissionMinor: number;
    driverPayoutMinor: number;
}
/**
 * TOTAL = BASE + TRIP DISTANCE + PICKUP COMPONENT (+ scheduled) × peak − discounts
 * Pure & deterministic → property-testable (Phase 13).
 */
export declare function calculatePrice(rules: PricingRuleset, input: PriceInput): PriceBreakdown;
export declare function formatMoney(minor: number, currency: CurrencyT): string;
