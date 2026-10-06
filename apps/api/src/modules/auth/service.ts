/**
 * AUTH SERVICE — argon2id hashing, JWT access tokens (jose), role gates.
 * Business rule (§21): never trust frontend permissions; every route re-checks server-side.
 */
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { Role, AccountStatus, type RoleT } from '@testmobil/shared';
import { db, newId, type UserRow } from '../../db/store.js';
import { AppError } from '../../errors.js';
import type { EnvT } from '../../env.js';

export interface TokenClaims { sub: string; role: RoleT; email: string; name: string }

const keyCache = new Map<string, Uint8Array>();
function secretKey(env: EnvT): Uint8Array {
  const enc = new TextEncoder();
  let k = keyCache.get(env.JWT_ACCESS_SECRET);
  if (!k) { k = enc.encode(env.JWT_ACCESS_SECRET); keyCache.set(env.JWT_ACCESS_SECRET, k); }
  return k;
}

export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try { return await argon2.verify(hash, pw); } catch { return false; }
}

export async function issueAccessToken(user: UserRow, env: EnvT): Promise<string> {
  return new SignJWT({ role: user.role, email: user.email, name: user.fullName })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secretKey(env));
}

export async function verifyToken(token: string, env: EnvT): Promise<TokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env));
    if (!payload.sub || typeof payload.role !== 'string') throw new Error('bad claims');
    return { sub: payload.sub, role: payload.role as RoleT, email: String(payload.email ?? ''), name: String(payload.name ?? '') };
  } catch {
    throw AppError.unauthenticated();
  }
}

export interface RegisterInput {
  email: string; password: string; fullName: string; phone: string; role: RoleT;
  driver?: { licenceNumber: string; licenceExpiry: string; canDriveManual: boolean };
}

export async function registerUser(input: RegisterInput): Promise<UserRow> {
  const email = input.email.trim().toLowerCase();
  if (db.emailIndex.has(email)) throw AppError.conflict('An account with this email already exists.');
  if (input.password.length < 8) throw AppError.validation('Password must be at least 8 characters.');

  const user: UserRow = {
    id: newId(), role: input.role, email, phone: input.phone, fullName: input.fullName,
    passwordHash: await hashPassword(input.password),
    status: AccountStatus.ACTIVE, createdAt: new Date().toISOString(),
  };
  db.users.set(user.id, user);
  db.emailIndex.set(email, user.id);

  if (input.role === Role.CUSTOMER) {
    db.customers.set(user.id, { userId: user.id });
  } else if (input.role === Role.DRIVER) {
    if (!input.driver) throw AppError.validation('Driver registration requires licence information.');
    db.drivers.set(user.id, {
      userId: user.id, availability: 'OFFLINE', lastLocation: null, lastSeenAt: null,
      canDriveManual: input.driver.canDriveManual,
      licenceNumber: input.driver.licenceNumber, licenceExpiry: input.driver.licenceExpiry,
      ratingSum: 0, ratingCount: 0,
    });
    // §4/§9: a new driver starts UNVERIFIED — verification records created, pending admin review.
    for (const t of ['IDENTITY', 'LICENSE'] as const) {
      db.verifications.push({ id: newId(), driverId: user.id, type: t, status: 'PENDING', documentKeys: [] });
    }
  }
  db.auditLog(user.id, 'AUTH_REGISTER', 'user', user.id, { role: user.role });
  return user;
}

export async function login(emailRaw: string, password: string): Promise<UserRow> {
  const email = emailRaw.trim().toLowerCase();
  const id = db.emailIndex.get(email);
  const user = id ? db.users.get(id) : undefined;
  // Constant-shape failure: don't reveal which part was wrong (§21).
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    throw new AppError('VALIDATION_FAILED', 'Invalid email or password.', 401);
  }
  if (user.status === AccountStatus.SUSPENDED) throw new AppError('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.', 403);
  if (user.status === AccountStatus.DELETED) throw AppError.notFound('Account');
  db.auditLog(user.id, 'AUTH_LOGIN', 'user', user.id);
  return user;
}

/** Server-side role gate used by routes/preHandler. */
export function requireRole(claims: TokenClaims, ...roles: RoleT[]) {
  if (!roles.includes(claims.role)) throw AppError.forbidden(`Requires role: ${roles.join(' or ')}.`);
  const user = db.users.get(claims.sub);
  if (!user) throw AppError.unauthenticated();
  if (user.status === AccountStatus.SUSPENDED) throw new AppError('ACCOUNT_SUSPENDED', 'Account suspended.', 403);
  return user;
}

/** Matching gate (§9): driver may receive offers only when ALL verifications VERIFIED. */
export function isDriverVerified(driverId: string): boolean {
  const vs = db.verifications.filter((v) => v.driverId === driverId);
  if (vs.length === 0) return false;
  return vs.every((v) => v.status === 'VERIFIED');
}
