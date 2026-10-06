/**
 * CUSTOMER SERVICE — profile, vehicles, emergency contacts (§4A/§13).
 */
import { db, newId, type VehicleRow } from '../../db/store.js';
import { AppError } from '../../errors.js';

export function upsertVehicle(s: { userId: string }, input: { plate: string; make: string; model: string; transmission: 'MANUAL' | 'AUTOMATIC' }): VehicleRow {
  const plate = input.plate.trim().toUpperCase();
  if (!/^[A-Z0-9 -]{2,15}$/.test(plate)) throw AppError.validation('Invalid plate format.');
  let v = [...db.vehicles.values()].find((x) => x.ownerId === s.userId && x.plate === plate);
  if (!v) {
    v = { id: newId(), ownerId: s.userId, plate, make: input.make.trim(), model: input.model.trim(), transmission: input.transmission };
    db.vehicles.set(v.id, v);
    db.auditLog(s.userId, 'VEHICLE_SAVED', 'vehicle', v.id, { plate });
  } else {
    Object.assign(v, { make: input.make.trim(), model: input.model.trim(), transmission: input.transmission });
  }
  return v;
}

export function listVehicles(s: { userId: string }): VehicleRow[] {
  return [...db.vehicles.values()].filter((v) => v.ownerId === s.userId);
}

export function setEmergencyContact(s: { userId: string }, contact: { name: string; phone: string }) {
  const prof = db.customers.get(s.userId);
  if (!prof) throw AppError.notFound('Customer profile');
  if (!contact.name.trim() || !/^[+0-9 ()-]{6,20}$/.test(contact.phone)) throw AppError.validation('Invalid emergency contact.');
  prof.emergencyContact = { name: contact.name.trim(), phone: contact.phone.trim() };
  db.auditLog(s.userId, 'EMERGENCY_CONTACT_SET', 'customer', s.userId);
}

export function getProfile(s: { userId: string }) {
  const prof = db.customers.get(s.userId);
  if (!prof) throw AppError.notFound('Customer profile');
  return { emergencyContact: prof.emergencyContact ?? null, vehicles: listVehicles(s) };
}
