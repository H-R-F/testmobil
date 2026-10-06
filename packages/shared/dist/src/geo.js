const EARTH_R_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;
/** Haversine great-circle distance in km — straight-line fallback for RANKING only
 *  (routed distance is used for display/pricing via MapsProvider, proposal §8). */
export function haversineKm(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.sqrt(s));
}
export function isValidLatLng(p) {
    if (!p || typeof p !== 'object')
        return false;
    const { lat, lng } = p;
    return (typeof lat === 'number' && typeof lng === 'number' &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
        Number.isFinite(lat) && Number.isFinite(lng));
}
/** Ray-casting point-in-polygon (zones are small simple polygons; PostGIS ST_Contains in prod). */
export function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const pi = poly[i], pj = poly[j];
        const xi = pi.lng, yi = pi.lat, xj = pj.lng, yj = pj.lat;
        const intersect = yi > pt.lat !== yj > pt.lat && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
        if (intersect)
            inside = !inside;
    }
    return inside;
}
