/** DTO contracts shared between API and frontends (brief §23 consistency). */
import type { TripStateT, TransitionActor } from './trip-state-machine.js';
import type { RoleT, DriverAvailabilityT, VerificationStatusT, PaymentStatusT } from './roles.js';
import type { PriceBreakdown, CurrencyT } from './pricing.js';

export interface LatLng {
  lat: number; // -90..90
  lng: number; // -180..180
}

export interface AuthenticatedUserDto {
  id: string;
  role: RoleT;
  email: string;
  fullName: string;
  /** DRIVER only — matching engine gate (§9): must be VERIFIED to receive offers. */
  driverVerified?: boolean;
}

export interface RegisterCustomerRequest {
  email: string;
  password: string;
  fullName: string;
  phone: string;
}

export interface RegisterDriverRequest extends RegisterCustomerRequest {
  licenceNumber: string;
  licenceExpiry: string; // ISO date
  canDriveManual: boolean;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthenticatedUserDto;
}

export interface QuoteRequest {
  pickup: LatLng & { address?: string };
  destination: LatLng & { address?: string };
  scheduledFor?: string; // ISO datetime; absent = immediate
  vehicleId?: string;
  promotionCode?: string;
}

export interface QuoteDto {
  id: string;
  expiresAt: string;
  estimateTripKm: number;
  estimatePickupKm: number | null; // null while searching (best candidate unknown)
  breakdown: PriceBreakdown;
  currency: CurrencyT;
}

export interface CreateTripRequest {
  quoteId: string;
  vehicleId: string;
  noteToDriver?: string;
}

export interface VehicleDto {
  id: string;
  plate: string;
  make: string;
  model: string;
  transmission: 'MANUAL' | 'AUTOMATIC';
}

export interface TripDto {
  id: string;
  status: TripStateT;
  createdAt: string;
  scheduledFor: string | null;
  origin: LatLng & { label?: string };
  destination: LatLng & { label?: string };
  quoteSnapshot: PriceBreakdown;
  customer: { id: string; fullName: string; phone?: string };
  vehicle?: VehicleDto;
  driver?: DriverPublicDto | null;
  etaSeconds?: number | null;
}

export interface DriverPublicDto {
  id: string;
  fullName: string;
  photoUrl?: string;
  ratingAvg: number;
  ratingCount: number;
  verified: boolean;
  canDriveManual: boolean;
}

export interface DriverDashboardDto {
  availability: DriverAvailabilityT;
  verified: boolean;
  verifications: Array<{ type: string; status: VerificationStatusT; expiresAt?: string }>;
  todayEarningsMinor: number;
  activeTrip: TripDto | null;
}

export interface TripOfferDto {
  tripId: string;
  offerId: string;
  pickupLabel: string;
  destinationLabel: string;
  distanceToPickupKm: number;
  tripDistanceKm: number;
  estimatedPayoutMinor: number;
  currency: CurrencyT;
  expiresAt: string;
  scheduledFor: string | null;
}

/** Handover record (brief §7) — digital evidence bundle before trip start. */
export interface HandoverRecordDto {
  tripId: string;
  phase: 'BEFORE' | 'AFTER';
  vehiclePlate: string;
  makeModel: string;
  odometerKm: number | null;
  fuelLevelPercent: number | null;
  batteryLevelPercent: number | null;
  damageNotes: Array<{ location: string; description: string; photoKeys: string[] }>;
  photoKeys: string[];
  gps: LatLng;
  driverConfirmedAt: string | null;
  customerConfirmedAt: string | null;
  createdAt: string;
}

export interface StartHandoverRequest {
  odometerKm?: number;
  fuelLevelPercent?: number;
  batteryLevelPercent?: number;
  damageNotes?: Array<{ location: string; description: string }>;
}

export interface ConfirmHandoverRequest {
  handoverId: string;
  as: 'DRIVER' | 'CUSTOMER';
}

export interface RateTripRequest {
  tripId: string;
  score: 1 | 2 | 3 | 4 | 5;
  comment?: string;
}

export interface TransitionRequestDto {
  to: TripStateT;
  actor: TransitionActor; // server OVERRIDES this from the authenticated session — never trusts client
  gps?: LatLng;
}

export interface PaymentDto {
  id: string;
  tripId: string;
  status: PaymentStatusT;
  amountMinor: number;
  currency: CurrencyT;
  receiptUrl?: string;
}

export interface SosRequest {
  tripId?: string;
  gps: LatLng;
  message?: string;
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
