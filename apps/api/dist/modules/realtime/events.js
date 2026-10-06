/**
 * Domain event bus (proposal §9). In prod this is Redis pub/sub fanning out to
 * multiple WS nodes; here it's an in-process emitter with the SAME event shapes,
 * so realtime clients and tests consume identical contracts.
 */
import { EventEmitter } from 'node:events';
const bus = new EventEmitter();
bus.setMaxListeners(100);
export function publish(ev) {
    bus.emit('domain', ev);
    bus.emit(`type:${ev.type}`, ev);
}
export function subscribe(handler) {
    bus.on('domain', handler);
    return () => bus.off('domain', handler);
}
