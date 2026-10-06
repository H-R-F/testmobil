/**
 * Pricing model types + PURE calculation engine (brief §10).
 * Rule VALUES are never hardcoded here — they arrive as PricingRule rows
 * from the DB (configurable by admin). This file defines the shape and math.
 * All money is integer minor units (cents) to avoid float drift (§12).
 */

export const Currency = { EUR: 'EUR', USD: 'USD', GBP: 'GBP' } as const;
export type CurrencyT = (typeof Currency)[keyof typeof Currency];

/** Configurable rule kinds stored in `pricing_rules` table. */
export const PricingRuleKey = {
  BASE_FEE: 'BASE_FEE', // minor units, e.g. 490 = €4.90
  PER_KM_FEE: 'PER_KM_FEE', // minor units per km (trip distance)
  PICKUP_FEE_PER_KM: 'PICKUP_FEE_PER_KM', // driver's own travel to customer (reachability component)
  PICKUP_MIN_FEE: 'PICKUP_MIN_FEE',
  SCHEDULED_BOOKING_FEE: 'SCHEDULED_BOOKING_FEE',
  CANCELLATION_FEE: 'CANCELLATION_FEE',
  PEAK_MULTIPLIER: 'PEAK_MULTIPLIER', // e.g. "1.25" — applied when surcharge.active
  PLATFORM_COMMISSION_PERCENT: 'PLATFORM_COMMISSION_PERCENT', // e.g. "20"
  QUOTE_TTL_SECONDS: 'QUOTE_TTL_SECONDS',
} as const;
export type PricingRuleKeyT = (typeof PricingRuleKey)[keyof typeof PricingRuleKey];

export interface PricingRuleset {
  currency: CurrencyT;
  baseFeeMinor: number;
  perKmFeeMinor: number;
  pickupFeePerKmMinor: number;
  pickupMinFeeMinor: number;
  scheduledBookingFeeMinor: number;
  peakMultiplier: number; // 1 = disabled
  platformCommissionPercent: number; // 0..100
  quoteTtlSeconds: number;
}

export interface PriceInput {
  tripDistanceKm: number; // customer-car route origin→destination
  pickupDistanceKm: number; // driver travel → customer (reachability)
  scheduled: boolean;
  peakActive: boolean;
  /** discount in minor units (from promotion); clamped so total >= 0 */
  discountMinor?: number;
}

export interface PriceLineItem {
  key: string;
  label: string;
  amountMinor: number; // negative for discounts
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

const round = (n: number) => Math.round(n);
const clamp0 = (n: number) => Math.max(0, n);

/**
 * TOTAL = BASE + TRIP DISTANCE + PICKUP COMPONENT (+ scheduled) × peak − discounts
 * Pure & deterministic → property-testable (Phase 13).
 */
export function calculatePrice(rules: PricingRuleset, input: PriceInput): PriceBreakdown {
  if (input.tripDistanceKm < 0 || input.pickupDistanceKm < 0) {
    throw new Error('Distances must be non-negative');
  }
  const items: PriceLineItem[] = [];

  items.push({ key: 'BASE_FEE', label: 'Base service fee', amountMinor: rules.baseFeeMinor });

  const tripFee = round(input.tripDistanceKm * rules.perKmFeeMinor);
  items.push({ key: 'TRIP_DISTANCE_FEE', label: `${input.tripDistanceKm.toFixed(1)} km trip`, amountMinor: tripFee });

  const pickupRaw = round(input.pickupDistanceKm * rules.pickupFeePerKmMinor);
  const pickupFee = Math.max(pickupRaw, input.pickupDistanceKm > 0 ? rules.pickupMinFeeMinor : 0);
  items.push({ key: 'PICKUP_COMPONENT', label: 'Driver arrival', amountMinor: pickupFee });

  if (input.scheduled) {
    items.push({ key: 'SCHEDULED_FEE', label: 'Scheduled booking', amountMinor: rules.scheduledBookingFeeMinor });
  }

  let subtotal = items.reduce((s, i) => s + i.amountMinor, 0);

  if (input.peakActive && rules.peakMultiplier > 1) {
    const surcharge = round(subtotal * (rules.peakMultiplier - 1));
    items.push({ key: 'PEAK_SURCHARGE', label: `Peak pricing ×${rules.peakMultiplier}`, amountMinor: surcharge });
    subtotal += surcharge;
  }

  const discount = clamp0(Math.min(input.discountMinor ?? 0, subtotal));
  if (discount > 0) {
    items.push({ key: 'DISCOUNT', label: 'Promotion', amountMinor: -discount });
  }

  const total = clamp0(subtotal - discount);
  const commission = round((total * rules.platformCommissionPercent) / 100);
  const payout = total - commission;

  return {
    currency: rules.currency,
    items,
    subtotalMinor: subtotal,
    totalMinor: total,
    commissionMinor: commission,
    driverPayoutMinor: payout,
  };
}

export function formatMoney(minor: number, currency: CurrencyT): string {
  const major = (minor / 100).toFixed(2);
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  return `${sym}${major}`;
}
