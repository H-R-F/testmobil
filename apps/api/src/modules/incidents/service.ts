/**
 * INCIDENTS / SOS SERVICE (brief §13) — honest framing: creating an incident alerts
 * ops immediately and shares live location; the app itself does NOT claim to be
 * emergency services (marketing copy rule §14-R8).
 */
import { db, newId, type IncidentRow } from '../../db/store.js';
import { AppError } from '../../errors.js';
import { publish } from '../realtime/events.js';
import { requestTransition, getTripForParty, type SessionCtx } from '../trips/service.js';
import { TripState, Role, type LatLng } from '@testmobil/shared';

export async function triggerSos(s: SessionCtx, input: { tripId?: string; gps: LatLng | null; message?: string }): Promise<IncidentRow> {
  // Never silently fail (§25): even if trip lookup fails, we still record the incident + alert ops.
  let tripOk = false;
  if (input.tripId) {
    try { getTripForParty(s, input.tripId); tripOk = true; } catch { /* foreign tripId → ignore linkage, keep SOS */ }
  }
  const inc: IncidentRow = {
    id: newId(), tripId: tripOk ? input.tripId! : null, reporterId: s.userId, reporterRole: s.role,
    type: 'SOS', severity: 'CRITICAL', status: 'OPEN',
    message: input.message?.slice(0, 1000) ?? '(no message)', gps: input.gps, createdAt: new Date().toISOString(),
  };
  db.incidents.push(inc);
  db.auditLog(s.userId, 'SOS_TRIGGERED', 'incident', inc.id, { tripId: inc.tripId });
  publish({ type: 'SosTriggered', tripId: inc.tripId, reporterId: s.userId, gps: inc.gps, incidentId: inc.id });

  // If mid-trip, move state machine to EMERGENCY (allowed from TRIP_STARTED/ARRIVING).
  if (tripOk && input.tripId) {
    const t = db.trips.get(input.tripId)!;
    if (t.status === TripState.TRIP_STARTED || t.status === TripState.ARRIVING) {
      await requestTransition(s, t.id, TripState.EMERGENCY, input.gps ?? undefined).catch(() => {/* keep incident regardless */});
    }
  }
  // Ops webhook alert (fire-and-forget; env OPS_ALERT_WEBHOOK_URL)
  const url = process.env.OPS_ALERT_WEBHOOK_URL;
  if (url) fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'SOS', incidentId: inc.id }) }).catch(() => {});
  return inc;
}

export function reportIncident(s: SessionCtx, input: { tripId?: string; type: 'SUPPORT' | 'DISPUTE'; severity?: 'LOW' | 'MEDIUM' | 'HIGH'; message: string }): IncidentRow {
  if (!input.message?.trim()) throw AppError.validation('Message required.');
  const inc: IncidentRow = {
    id: newId(), tripId: input.tripId ?? null, reporterId: s.userId, reporterRole: s.role,
    type: input.type, severity: input.severity ?? 'MEDIUM', status: 'OPEN',
    message: input.message.slice(0, 2000), gps: null, createdAt: new Date().toISOString(),
  };
  db.incidents.push(inc);
  db.auditLog(s.userId, 'INCIDENT_REPORTED', 'incident', inc.id, { type: inc.type });
  return inc;
}

export function adminListIncidents(status?: IncidentRow['status']): IncidentRow[] {
  return db.incidents.filter((i) => !status || i.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function adminResolveIncident(adminId: string, incidentId: string, outcome: 'COMPLETE_TRIP' | 'CANCEL_TRIP' | 'NONE'): Promise<void> {
  const inc = db.incidents.find((i) => i.id === incidentId);
  if (!inc) throw AppError.notFound('Incident');
  inc.status = 'RESOLVED';
  if (inc.tripId && outcome !== 'NONE') {
    const s: SessionCtx = { userId: adminId, role: Role.ADMIN, actor: 'ADMIN' };
    await requestTransition(s, inc.tripId, outcome === 'COMPLETE_TRIP' ? TripState.TRIP_COMPLETED : TripState.CANCELLED_BY_CUSTOMER);
  }
  db.auditLog(adminId, 'INCIDENT_RESOLVED', 'incident', inc.id, { outcome });
}
