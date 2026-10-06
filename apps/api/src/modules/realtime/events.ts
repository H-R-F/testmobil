/**
 * Domain event bus (proposal §9). In prod this is Redis pub/sub fanning out to
 * multiple WS nodes; here it's an in-process emitter with the SAME event shapes,
 * so realtime clients and tests consume identical contracts.
 */
import { EventEmitter } from 'node:events';
import type { LatLng, TripStateT } from '@testmobil/shared';

export type DomainEvent =
  | { type: 'TripStatusChanged'; tripId: string; from: TripStateT | null; to: TripStateT; ts: string }
  | { type: 'DriverAssigned'; tripId: string; driverId: string; etaSeconds: number | null }
  | { type: 'TripOffered'; driverId: string; tripId: string; offerId: string; expiresAt: string }
  | { type: 'OfferExpired'; driverId: string; tripId: string; offerId: string }
  | { type: 'HandoverPending'; tripId: string }
  | { type: 'HandoverConfirmed'; tripId: string }
  | { type: 'DriverLocationUpdate'; tripId: string; driverId: string; gps: LatLng; etaSeconds: number | null }
  | { type: 'NoDriversAvailable'; tripId: string }
  | { type: 'SosTriggered'; tripId: string | null; reporterId: string; gps: LatLng | null; incidentId: string }
  | { type: 'Notification'; userId: string; title: string; body: string };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function publish(ev: DomainEvent) {
  bus.emit('domain', ev);
  bus.emit(`type:${ev.type}`, ev);
}

export function subscribe(handler: (ev: DomainEvent) => void): () => void {
  bus.on('domain', handler);
  return () => bus.off('domain', handler);
}
