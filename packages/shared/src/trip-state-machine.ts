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

export const TripState = {
  REQUESTED: 'REQUESTED',
  SEARCHING_DRIVER: 'SEARCHING_DRIVER',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  HANDOVER_PENDING: 'HANDOVER_PENDING',
  HANDOVER_CONFIRMED: 'HANDOVER_CONFIRMED',
  TRIP_STARTED: 'TRIP_STARTED',
  ARRIVING: 'ARRIVING',
  TRIP_COMPLETED: 'TRIP_COMPLETED',
  // terminal / exceptional
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
  DRIVER_NO_SHOW: 'DRIVER_NO_SHOW',
  CUSTOMER_NO_SHOW: 'CUSTOMER_NO_SHOW',
  EMERGENCY: 'EMERGENCY',
  DISPUTED: 'DISPUTED',
} as const;

export type TripStateT = (typeof TripState)[keyof typeof TripState];

export const ALL_TRIP_STATES: readonly TripStateT[] = Object.values(TripState);

/** States from which no further transition is allowed. */
export const TERMINAL_STATES: ReadonlySet<TripStateT> = new Set<TripStateT>([
  TripState.TRIP_COMPLETED,
  TripState.CANCELLED_BY_CUSTOMER,
  TripState.CANCELLED_BY_DRIVER,
]);

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
export const TRANSITIONS: Readonly<Partial<Record<TripStateT, readonly TransitionRule[]>>> = {
  REQUESTED: [
    { to: TripState.SEARCHING_DRIVER, actors: ['SYSTEM'], reason: 'Matching engine begins driver search.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Customer cancels before assignment.' },
  ],
  SEARCHING_DRIVER: [
    { to: TripState.DRIVER_ASSIGNED, actors: ['SYSTEM'], reason: 'A driver accepted an offer.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Customer cancels while searching.' },
  ],
  DRIVER_ASSIGNED: [
    { to: TripState.DRIVER_EN_ROUTE, actors: ['DRIVER', 'SYSTEM'], reason: 'Driver started travelling to the customer.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Customer cancels after assignment.' },
    { to: TripState.CANCELLED_BY_DRIVER, actors: ['DRIVER', 'ADMIN'], reason: 'Driver released the trip.' },
  ],
  DRIVER_EN_ROUTE: [
    { to: TripState.DRIVER_ARRIVED, actors: ['DRIVER', 'SYSTEM'], reason: 'Driver reached the pickup location.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Customer cancels while driver en route (may incur fee).' },
    { to: TripState.CANCELLED_BY_DRIVER, actors: ['DRIVER', 'ADMIN'], reason: 'Driver cancelled en route.' },
    { to: TripState.DRIVER_NO_SHOW, actors: ['SYSTEM', 'ADMIN'], reason: 'Driver did not arrive within SLA window.' },
  ],
  DRIVER_ARRIVED: [
    { to: TripState.HANDOVER_PENDING, actors: ['SYSTEM', 'DRIVER'], reason: 'Vehicle handover inspection begins.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Customer cancels at arrival.' },
    { to: TripState.CUSTOMER_NO_SHOW, actors: ['SYSTEM', 'ADMIN'], reason: 'Customer did not appear / did not respond.' },
    { to: TripState.DRIVER_NO_SHOW, actors: ['ADMIN'], reason: 'Arrival marked in error; ops correction.' },
  ],
  HANDOVER_PENDING: [
    { to: TripState.HANDOVER_CONFIRMED, actors: ['SYSTEM'], reason: 'Both driver and customer confirmed handover record.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Customer rejects handover / cancels.' },
    { to: TripState.CANCELLED_BY_DRIVER, actors: ['DRIVER', 'ADMIN'], reason: 'Driver aborts — e.g. vehicle condition unsafe/undriveable.' },
  ],
  HANDOVER_CONFIRMED: [
    { to: TripState.TRIP_STARTED, actors: ['DRIVER', 'SYSTEM'], reason: 'Driver takes control of the vehicle and starts the trip.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['CUSTOMER', 'ADMIN'], reason: 'Cancelled before trip start.' },
  ],
  TRIP_STARTED: [
    { to: TripState.ARRIVING, actors: ['SYSTEM', 'DRIVER'], reason: 'Destination imminent (ETA threshold or driver signal).' },
    { to: TripState.EMERGENCY, actors: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM'], reason: 'SOS triggered during trip.' },
    { to: TripState.DISPUTED, actors: ['ADMIN', 'SYSTEM'], reason: 'Dispute opened on active trip.' },
  ],
  ARRIVING: [
    { to: TripState.TRIP_COMPLETED, actors: ['DRIVER', 'SYSTEM'], reason: 'Trip finished at destination; payment follows.' },
    { to: TripState.EMERGENCY, actors: ['CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM'], reason: 'SOS triggered.' },
    { to: TripState.DISPUTED, actors: ['ADMIN', 'SYSTEM'], reason: 'Dispute opened.' },
  ],
  EMERGENCY: [
    { to: TripState.TRIP_COMPLETED, actors: ['ADMIN', 'SYSTEM'], reason: 'Ops resolved emergency; trip closed normally.' },
    { to: TripState.DISPUTED, actors: ['ADMIN'], reason: 'Emergency escalated to dispute review.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['ADMIN'], reason: 'Ops cancelled after emergency resolution.' },
  ],
  DISPUTED: [
    { to: TripState.TRIP_COMPLETED, actors: ['ADMIN'], reason: 'Dispute resolved in favour of completion.' },
    { to: TripState.CANCELLED_BY_CUSTOMER, actors: ['ADMIN'], reason: 'Dispute resolved as customer cancellation.' },
    { to: TripState.CANCELLED_BY_DRIVER, actors: ['ADMIN'], reason: 'Dispute resolved as driver cancellation.' },
  ],
};

export interface TransitionCheck {
  ok: boolean;
  code?: 'TRIP_TERMINAL_STATE' | 'TRIP_INVALID_TRANSITION' | 'TRIP_FORBIDDEN_ACTOR';
  message?: string;
}

/** Pure validation — used by API service layer AND unit-tested exhaustively. */
export function canTransition(from: TripStateT, to: TripStateT, actor: TransitionActor): TransitionCheck {
  if (TERMINAL_STATES.has(from)) {
    return { ok: false, code: 'TRIP_TERMINAL_STATE', message: `Trip in terminal state ${from}; no transitions allowed.` };
  }
  const rules = TRANSITIONS[from] ?? [];
  const rule = rules.find((r) => r.to === to);
  if (!rule) {
    return { ok: false, code: 'TRIP_INVALID_TRANSITION', message: `Transition ${from} → ${to} is not allowed.` };
  }
  if (!rule.actors.includes(actor)) {
    return {
      ok: false,
      code: 'TRIP_FORBIDDEN_ACTOR',
      message: `Actor ${actor} may not transition ${from} → ${to}. Allowed: ${rule.actors.join(', ')}.`,
    };
  }
  return { ok: true };
}

export function allowedTransitionsFrom(from: TripStateT): readonly TripStateT[] {
  if (TERMINAL_STATES.has(from)) return [];
  return (TRANSITIONS[from] ?? []).map((r) => r.to);
}

/** True while a trip is actively in progress (affects driver availability = BUSY). */
export function isActiveTripState(s: TripStateT): boolean {
  return (
    s === TripState.DRIVER_ASSIGNED ||
    s === TripState.DRIVER_EN_ROUTE ||
    s === TripState.DRIVER_ARRIVED ||
    s === TripState.HANDOVER_PENDING ||
    s === TripState.HANDOVER_CONFIRMED ||
    s === TripState.TRIP_STARTED ||
    s === TripState.ARRIVING ||
    s === TripState.EMERGENCY
  );
}

/** States where the customer has a driver committed (show driver card + live tracking). */
export function hasAssignedDriver(s: TripStateT): boolean {
  return isActiveTripState(s) && s !== TripState.DRIVER_ASSIGNED ? true : s === TripState.DRIVER_ASSIGNED;
}
