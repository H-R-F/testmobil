/** Roles & availability enums — shared by API (authorization) and all frontends (rendering). */

export const Role = {
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
  ADMIN: 'ADMIN',
} as const;
export type RoleT = (typeof Role)[keyof typeof Role];

export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DELETED: 'DELETED',
} as const;
export type AccountStatusT = (typeof AccountStatus)[keyof typeof AccountStatus];

/** Driver availability — matching engine only considers ONLINE + VERIFIED + not BUSY. */
export const DriverAvailability = {
  OFFLINE: 'OFFLINE',
  ONLINE: 'ONLINE',
  BUSY: 'BUSY',
} as const;
export type DriverAvailabilityT = (typeof DriverAvailability)[keyof typeof DriverAvailability];

export const VerificationType = {
  IDENTITY: 'IDENTITY',
  LICENSE: 'LICENSE',
  BACKGROUND: 'BACKGROUND',
} as const;
export type VerificationTypeT = (typeof VerificationType)[keyof typeof VerificationType];

export const VerificationStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
} as const;
export type VerificationStatusT = (typeof VerificationStatus)[keyof typeof VerificationStatus];

export const HandoverPhase = { BEFORE: 'BEFORE', AFTER: 'AFTER' } as const;
export type HandoverPhaseT = (typeof HandoverPhase)[keyof typeof HandoverPhase];

export const PaymentStatus = {
  CREATED: 'CREATED',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatusT = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Canonical error codes returned by the API envelope (brief §23 consistency). */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  TRIP_TERMINAL_STATE: 'TRIP_TERMINAL_STATE',
  TRIP_INVALID_TRANSITION: 'TRIP_INVALID_TRANSITION',
  TRIP_FORBIDDEN_ACTOR: 'TRIP_FORBIDDEN_ACTOR',
  NO_DRIVERS_AVAILABLE: 'NO_DRIVERS_AVAILABLE',
  DRIVER_NOT_VERIFIED: 'DRIVER_NOT_VERIFIED',
  DRIVER_OFFLINE: 'DRIVER_OFFLINE',
  DRIVER_BUSY: 'DRIVER_BUSY',
  HANDOVER_INCOMPLETE: 'HANDOVER_INCOMPLETE',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  OUTSIDE_SERVICE_ZONE: 'OUTSIDE_SERVICE_ZONE',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCodeT = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorEnvelope {
  code: ErrorCodeT;
  message: string;
  details?: unknown;
  requestId?: string;
}
