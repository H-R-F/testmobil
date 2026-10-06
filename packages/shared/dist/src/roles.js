/** Roles & availability enums — shared by API (authorization) and all frontends (rendering). */
export const Role = {
    CUSTOMER: 'CUSTOMER',
    DRIVER: 'DRIVER',
    ADMIN: 'ADMIN',
};
export const AccountStatus = {
    ACTIVE: 'ACTIVE',
    SUSPENDED: 'SUSPENDED',
    DELETED: 'DELETED',
};
/** Driver availability — matching engine only considers ONLINE + VERIFIED + not BUSY. */
export const DriverAvailability = {
    OFFLINE: 'OFFLINE',
    ONLINE: 'ONLINE',
    BUSY: 'BUSY',
};
export const VerificationType = {
    IDENTITY: 'IDENTITY',
    LICENSE: 'LICENSE',
    BACKGROUND: 'BACKGROUND',
};
export const VerificationStatus = {
    PENDING: 'PENDING',
    VERIFIED: 'VERIFIED',
    REJECTED: 'REJECTED',
    EXPIRED: 'EXPIRED',
};
export const HandoverPhase = { BEFORE: 'BEFORE', AFTER: 'AFTER' };
export const PaymentStatus = {
    CREATED: 'CREATED',
    AUTHORIZED: 'AUTHORIZED',
    CAPTURED: 'CAPTURED',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
    PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
};
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
};
