/** Geo helpers used by matching ranking (PostGIS mirrors these in SQL for prod scale). */
import type { LatLng } from './dto.js';
/** Haversine great-circle distance in km — straight-line fallback for RANKING only
 *  (routed distance is used for display/pricing via MapsProvider, proposal §8). */
export declare function haversineKm(a: LatLng, b: LatLng): number;
export declare function isValidLatLng(p: unknown): p is LatLng;
/** Ray-casting point-in-polygon (zones are small simple polygons; PostGIS ST_Contains in prod). */
export declare function pointInPolygon(pt: LatLng, poly: LatLng[]): boolean;
