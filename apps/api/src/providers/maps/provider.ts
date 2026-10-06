/**
 * MapsProvider abstraction (proposal §8) — no provider SDK leaks into domain logic.
 * `LocalMapsProvider` is a deterministic dev/test adapter (haversine-based routing).
 * Google/Mapbox adapters plug in via env MAPS_PROVIDER without touching callers.
 */
import { haversineKm, type LatLng } from '@testmobil/shared';

export interface RouteResult { distanceKm: number; durationSeconds: number }

export interface MapsProvider {
  readonly name: string;
  route(origin: LatLng, destination: LatLng): Promise<RouteResult>;
  geocode(query: string): Promise<Array<LatLng & { label: string }>>;
}

/** Average urban speeds used for ETA estimates (dev adapter; real provider returns live ETA). */
const DRIVING_KMH = 28;
const MIN_DRIVE_SECONDS = 60;

export class LocalMapsProvider implements MapsProvider {
  readonly name = 'local';

  async route(origin: LatLng, destination: LatLng): Promise<RouteResult> {
    // ~1.35 detour factor approximates street routing vs straight line
    const km = round2(haversineKm(origin, destination) * 1.35);
    const seconds = Math.max(MIN_DRIVE_SECONDS, Math.round((km / DRIVING_KMH) * 3600));
    return { distanceKm: km, durationSeconds: seconds };
  }

  async geocode(query: string): Promise<Array<LatLng & { label: string }>> {
    // Dev-only: "lat,lng" passthrough so demos work offline. Real adapter calls provider API.
    const m = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
    if (m) return [{ lat: Number(m[1]), lng: Number(m[2]), label: query }];
    return [];
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

let instance: MapsProvider = new LocalMapsProvider();
export function getMapsProvider(): MapsProvider { return instance; }
export function setMapsProvider(p: MapsProvider) { instance = p; }
