/**
 * MapsProvider abstraction (proposal §8) — no provider SDK leaks into domain logic.
 * `LocalMapsProvider` is a deterministic dev/test adapter (haversine-based routing).
 * Google/Mapbox adapters plug in via env MAPS_PROVIDER without touching callers.
 */
import { haversineKm } from '@testmobil/shared';
/** Average urban speeds used for ETA estimates (dev adapter; real provider returns live ETA). */
const DRIVING_KMH = 28;
const MIN_DRIVE_SECONDS = 60;
export class LocalMapsProvider {
    name = 'local';
    async route(origin, destination) {
        // ~1.35 detour factor approximates street routing vs straight line
        const km = round2(haversineKm(origin, destination) * 1.35);
        const seconds = Math.max(MIN_DRIVE_SECONDS, Math.round((km / DRIVING_KMH) * 3600));
        return { distanceKm: km, durationSeconds: seconds };
    }
    async geocode(query) {
        // Dev-only: "lat,lng" passthrough so demos work offline. Real adapter calls provider API.
        const m = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
        if (m)
            return [{ lat: Number(m[1]), lng: Number(m[2]), label: query }];
        return [];
    }
}
const round2 = (n) => Math.round(n * 100) / 100;
let instance = new LocalMapsProvider();
export function getMapsProvider() { return instance; }
export function setMapsProvider(p) { instance = p; }
