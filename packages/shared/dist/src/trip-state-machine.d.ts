/**
 * TRIP STATE MACHINE — single source of truth for trip lifecycle (brief §8).
 *
 * Trip status is NEVER an arbitrary string: every state is declared here,
 * every transition is validated against TRANSITIONS, and illegal transitions
 * must be rejected by the API layer (server-side enforcement, principle §27).
 *
 * Happy path:
 *   REQUESTED → SEARCHING_DRIVER → DRIVER_ASSIGNED → DRIVER_EN_ROUTE
 *   → DRIVER_ARRIVED → HANDOVER_PENDING → HANDOVER_CONFIRMED → TRIP_STARTED
 *   → ARRIVING → TRIP_COMPLETED
 *
 * Terminal failure/edge states per brief: CANCELLED_BY_CUSTOMER,
 * CANCELLED_BY_DRIVER, DRIVER_NO_SHOW, CUSTOMER_NO_SHOW, EMERGENCY, DISPUTED.
 */
export declare const TripState: {
    readonly REQUESTED: "REQUESTED";
    readonly SEARCHING_DRIVER: "SEARCHING_DRIVER";
    readonly DRIVER_ASSIGNED: "DRIVER_ASSIGNED";
    readonly DRIVER_EN_ROUTE: "DRIVER_EN_ROUTE";
    readonly DRIVER_ARRIVED: "DRIVER_ARRIVED";
    readonly HANDOVER_PENDING: "HANDOVER_PENDING";
    readonly HANDOVER_CONFIRMED: "HANDOVER_CONFIRMED";
    readonly TRIP_STARTED: "TRIP_STARTED";
    readonly ARRIVING: "ARRIVING";
    readonly TRIP_COMPLETED: "TRIP_COMPLETED";
    readonly CANCELLED_BY_CUSTOMER: "CANCELLED_BY_CUSTOMER";
    readonly CANCELLED_BY_DRIVER: "CANCELLED_BY_DRIVER";
    readonly DRIVER_NO_SHOW: "DRIVER_NO_SHOW";
    readonly CUSTOMER_NO_SHOW: "CUSTOMER_NO_SHOW";
    readonly EMERGENCY: "EMERGENCY";
    readonly DISPUTED: "DISPUTED";
};
export type TripStateT = (typeof TripState)[keyof typeof TripState];
export declare const ALL_TRIP_STATES: readonly TripStateT[];
/** States from which no further transition is allowed. */
export declare const TERMINAL_STATES: ReadonlySet<TripStateT>;
/** Who may trigger a given transition (server checks role AND ownership). */
export type TransitionActor = 'SYSTEM' | 'CUSTOMER' | 'DRIVER' | 'ADMIN';
interface TransitionRule {
    to: TripStateT;
    /** Which actors may cause this transition. SYSTEM = backend jobs/matching engine. */
    actors: readonly TransitionActor[];
    /** Human-readable reason surfaced in logs/UI when blocked. */
    reason: string;
}
/**
 * Allowed transitions map. Deliberately narrow: e.g. TRIP_STARTED can ONLY be
 * reached from HANDOVER_CONFIRMED — enforcing the vehicle-handover gate (§7).
 */
export declare const TRANSITIONS: Readonly<Partial<Record<TripStateT, readonly TransitionRule[]>>>;
export interface TransitionCheck {
    ok: boolean;
    code?: 'TRIP_TERMINAL_STATE' | 'TRIP_INVALID_TRANSITION' | 'TRIP_FORBIDDEN_ACTOR';
    message?: string;
}
/** Pure validation — used by API service layer AND unit-tested exhaustively. */
export declare function canTransition(from: TripStateT, to: TripStateT, actor: TransitionActor): TransitionCheck;
export declare function allowedTransitionsFrom(from: TripStateT): readonly TripStateT[];
/** True while a trip is actively in progress (affects driver availability = BUSY). */
export declare function isActiveTripState(s: TripStateT): boolean;
/** States where the customer has a driver committed (show driver card + live tracking). */
export declare function hasAssignedDriver(s: TripStateT): boolean;
export {};
