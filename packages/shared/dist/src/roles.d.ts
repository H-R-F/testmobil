/** Roles & availability enums — shared by API (authorization) and all frontends (rendering). */
export declare const Role: {
    readonly CUSTOMER: "CUSTOMER";
    readonly DRIVER: "DRIVER";
    readonly ADMIN: "ADMIN";
};
export type RoleT = (typeof Role)[keyof typeof Role];
export declare const AccountStatus: {
    readonly ACTIVE: "ACTIVE";
    readonly SUSPENDED: "SUSPENDED";
    readonly DELETED: "DELETED";
};
export type AccountStatusT = (typeof AccountStatus)[keyof typeof AccountStatus];
/** Driver availability — matching engine only considers ONLINE + VERIFIED + not BUSY. */
export declare const DriverAvailability: {
    readonly OFFLINE: "OFFLINE";
    readonly ONLINE: "ONLINE";
    readonly BUSY: "BUSY";
};
export type DriverAvailabilityT = (typeof DriverAvailability)[keyof typeof DriverAvailability];
export declare const VerificationType: {
    readonly IDENTITY: "IDENTITY";
    readonly LICENSE: "LICENSE";
    readonly BACKGROUND: "BACKGROUND";
};
export type VerificationTypeT = (typeof VerificationType)[keyof typeof VerificationType];
export declare const VerificationStatus: {
    readonly PENDING: "PENDING";
    readonly VERIFIED: "VERIFIED";
    readonly REJECTED: "REJECTED";
    readonly EXPIRED: "EXPIRED";
};
export type VerificationStatusT = (typeof VerificationStatus)[keyof typeof VerificationStatus];
export declare const HandoverPhase: {
    readonly BEFORE: "BEFORE";
    readonly AFTER: "AFTER";
};
export type HandoverPhaseT = (typeof HandoverPhase)[keyof typeof HandoverPhase];
export declare const PaymentStatus: {
    readonly CREATED: "CREATED";
    readonly AUTHORIZED: "AUTHORIZED";
    readonly CAPTURED: "CAPTURED";
    readonly FAILED: "FAILED";
    readonly REFUNDED: "REFUNDED";
    readonly PARTIALLY_REFUNDED: "PARTIALLY_REFUNDED";
};
export type PaymentStatusT = (typeof PaymentStatus)[keyof typeof PaymentStatus];
/** Canonical error codes returned by the API envelope (brief §23 consistency). */
export declare const ErrorCode: {
    readonly VALIDATION_FAILED: "VALIDATION_FAILED";
    readonly UNAUTHENTICATED: "UNAUTHENTICATED";
    readonly FORBIDDEN: "FORBIDDEN";
    readonly NOT_FOUND: "NOT_FOUND";
    readonly RATE_LIMITED: "RATE_LIMITED";
    readonly CONFLICT: "CONFLICT";
    readonly TRIP_TERMINAL_STATE: "TRIP_TERMINAL_STATE";
    readonly TRIP_INVALID_TRANSITION: "TRIP_INVALID_TRANSITION";
    readonly TRIP_FORBIDDEN_ACTOR: "TRIP_FORBIDDEN_ACTOR";
    readonly NO_DRIVERS_AVAILABLE: "NO_DRIVERS_AVAILABLE";
    readonly DRIVER_NOT_VERIFIED: "DRIVER_NOT_VERIFIED";
    readonly DRIVER_OFFLINE: "DRIVER_OFFLINE";
    readonly DRIVER_BUSY: "DRIVER_BUSY";
    readonly HANDOVER_INCOMPLETE: "HANDOVER_INCOMPLETE";
    readonly QUOTE_EXPIRED: "QUOTE_EXPIRED";
    readonly OUTSIDE_SERVICE_ZONE: "OUTSIDE_SERVICE_ZONE";
    readonly PAYMENT_FAILED: "PAYMENT_FAILED";
    readonly ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED";
    readonly INTERNAL: "INTERNAL";
};
export type ErrorCodeT = (typeof ErrorCode)[keyof typeof ErrorCode];
export interface ApiErrorEnvelope {
    code: ErrorCodeT;
    message: string;
    details?: unknown;
    requestId?: string;
}
