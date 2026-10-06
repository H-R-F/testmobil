/**
 * IN-MEMORY REPOSITORY — dev/test data layer implementing the SAME interfaces the
 * Postgres/Drizzle repositories will implement in Phase 3+ (proposal §4 module
 * convention: routes → service → repository). Swapping this out later touches no
 * business logic. NOT frontend mock logic: all rules are enforced server-side here.
 */
import { ulid } from 'ulidx';
import {
  TripState, type TripStateT, type TransitionActor,
  Role, DriverAvailability, VerificationStatus, HandoverPhase,
  type LatLng, type PricingRuleset, type PriceBreakdown,
} from '@testmobil/shared';

export const newId = () => ulid().toLowerCase();

type RoleT2 = (typeof Role)[keyof typeof Role];
type AvailabilityT2 = (typeof DriverAvailability)[keyof typeof DriverAvailability];
type VerifStatusT2 = (typeof VerificationStatus)[keyof typeof VerificationStatus];
type PhaseT2 = (typeof HandoverPhase)[keyof typeof HandoverPhase];

export interface UserRow {
  id: string; role: RoleT2; email: string; phone: string; fullName: string;
  passwordHash: string; status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  createdAt: string;
}

export interface CustomerProfileRow { userId: string; emergencyContact?: { name: string; phone: string } }

export interface DriverProfileRow {
  userId: string;
  availability: AvailabilityT2;
  lastLocation: LatLng | null;
  lastSeenAt: string | null;
  canDriveManual: boolean;
  licenceNumber: string;
  licenceExpiry: string;
  ratingSum: number; ratingCount: number;
}

export interface VerificationRow {
  id: string; driverId: string; type: 'IDENTITY' | 'LICENSE' | 'BACKGROUND';
  status: VerifStatusT2; expiresAt?: string; documentKeys: string[];
  reviewedBy?: string; reviewedAt?: string;
}

export interface VehicleRow {
  id: string; ownerId: string; plate: string; make: string; model: string;
  transmission: 'MANUAL' | 'AUTOMATIC';
}

export interface TripRow {
  id: string;
  customerId: string;
  driverId: string | null;
  vehicleId: string | null;
  status: TripStateT;
  origin: LatLng & { label?: string };
  destination: LatLng & { label?: string };
  scheduledFor: string | null;
  quoteSnapshot: PriceBreakdown;
  tripDistanceKm: number;
  pickupDistanceKm: number;
  etaSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  noteToDriver?: string;
}

export interface StatusHistoryRow {
  id: string; tripId: string; fromState: TripStateT | null; toState: TripStateT;
  actor: TransitionActor; actorId: string | null; gps: LatLng | null; ts: string; reason?: string;
}

export interface HandoverRow {
  id: string; tripId: string; phase: PhaseT2;
  odometerKm: number | null; fuelLevelPercent: number | null; batteryLevelPercent: number | null;
  damageNotes: Array<{ location: string; description: string; photoKeys: string[] }>;
  photoKeys: string[];
  gps: LatLng;
  driverConfirmedAt: string | null;
  customerConfirmedAt: string | null;
  createdAt: string;
}

export interface QuoteRow {
  id: string; customerId: string; breakdown: PriceBreakdown;
  origin: LatLng; destination: LatLng; tripDistanceKm: number;
  scheduledFor: string | null; expiresAt: string; consumed: boolean;
}

export interface OfferRow {
  id: string; tripId: string; driverId: string;
  distanceToPickupKm: number; estimatedPayoutMinor: number;
  expiresAt: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
  createdAt: string;
}

export interface PaymentRow {
  id: string; tripId: string; provider: string; intentId: string;
  amountMinor: number; currency: string;
  status: 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  commissionMinor: number; payoutMinor: number;
  createdAt: string;
}

export interface IncidentRow {
  id: string; tripId: string | null; reporterId: string; reporterRole: RoleT2;
  type: 'SOS' | 'SUPPORT' | 'DISPUTE' | 'ANOMALY';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  message: string; gps: LatLng | null; createdAt: string;
}

export interface AuditRow { id: string; actorId: string | null; action: string; entity: string; entityId: string; ts: string; meta?: Record<string, unknown> }

export interface ZoneRow { id: string; name: string; polygon: LatLng[]; active: boolean }

export class Db {
  users = new Map<string, UserRow>();
  emailIndex = new Map<string, string>();
  customers = new Map<string, CustomerProfileRow>();
  drivers = new Map<string, DriverProfileRow>();
  verifications: VerificationRow[] = [];
  vehicles = new Map<string, VehicleRow>();
  trips = new Map<string, TripRow>();
  statusHistory: StatusHistoryRow[] = [];
  handovers = new Map<string, HandoverRow[]>(); // by tripId
  quotes = new Map<string, QuoteRow>();
  offers: OfferRow[] = [];
  payments = new Map<string, PaymentRow>();
  incidents: IncidentRow[] = [];
  audit: AuditRow[] = [];
  zones: ZoneRow[] = [];
  pricingRulesets = new Map<string, PricingRuleset>(); // zoneId|default → ruleset (§10: DB-configured)

  constructor() {
    // Seed defaults behave like pricing_rules table rows — engine reads them; values live in data, not code paths.
    this.pricingRulesets.set('default', {
      currency: 'EUR', baseFeeMinor: 490, perKmFeeMinor: 150, pickupFeePerKmMinor: 100,
      pickupMinFeeMinor: 200, scheduledBookingFeeMinor: 300, peakMultiplier: 1,
      platformCommissionPercent: 20, quoteTtlSeconds: 300,
    });
  }

  ruleset(): PricingRuleset { return this.pricingRulesets.get('default')!; }

  auditLog(actorId: string | null, action: string, entity: string, entityId: string, meta?: Record<string, unknown>) {
    this.audit.push({ id: newId(), actorId, action, entity, entityId, ts: new Date().toISOString(), meta });
  }

  recordTransition(tripId: string, from: TripStateT | null, to: TripStateT, actor: TransitionActor, actorId: string | null, gps: LatLng | null, reason?: string) {
    this.statusHistory.push({ id: newId(), tripId, fromState: from, toState: to, actor, actorId, gps, ts: new Date().toISOString(), reason });
    const t = this.trips.get(tripId);
    if (t) { t.status = to; t.updatedAt = new Date().toISOString(); }
  }
}

export const db = new Db();

/** Reset between tests (fresh maps + fresh seeded rulesets). */
export function resetDb() {
  const fresh = new Db();
  Object.assign(db, fresh);
}
