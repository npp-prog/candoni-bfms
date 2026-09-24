import {
  BfmsError,
  COL,
  hasPermission,
  canAccessBarangay,
  manilaToday,
  type BarangayScope,
  type Permission,
  type RoleCode,
  type ScopedRoles,
  type UserAssignmentDoc,
  type UserDoc,
} from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './admin';

export interface CallerContext {
  uid: string;
  userName: string;
  email: string;
  assignments: ScopedRoles[];
  requestId: string;
  /** roles held at a given barangay (incl. ALL) */
  rolesAt(barangayId: BarangayScope): RoleCode[];
  can(permission: Permission, barangayId: BarangayScope): boolean;
  /** Throws permission-denied unless the caller holds `permission` at `barangayId`. */
  require(permission: Permission, barangayId: BarangayScope): void;
  requireBarangay(barangayId: BarangayScope): void;
}

/**
 * Load the caller's identity FRESH from Firestore (not only the token claims),
 * so a revoked assignment takes effect immediately.
 */
export async function loadCallerContext(uid: string, requestId: string): Promise<CallerContext> {
  const userSnap = await db.collection(COL.users).doc(uid).get();
  const user = userSnap.data() as UserDoc | undefined;
  if (!user || !user.active) throw new HttpsError('permission-denied', 'Your account is inactive or not registered in BFMS.');

  const today = manilaToday();
  const asgSnap = await db.collection(COL.userAssignments).where('uid', '==', uid).where('active', '==', true).get();
  const assignments: ScopedRoles[] = asgSnap.docs
    .map((d) => d.data() as UserAssignmentDoc)
    .filter((a) => a.validFrom <= today && (!a.validTo || a.validTo >= today))
    .map((a) => ({ scope: a.barangayId, roles: a.roles }));

  const ctx: CallerContext = {
    uid,
    userName: user.displayName || user.email,
    email: user.email,
    assignments,
    requestId,
    rolesAt(bid) {
      const s = new Set<RoleCode>();
      for (const a of assignments) if (a.scope === 'ALL' || a.scope === bid) a.roles.forEach((r) => s.add(r));
      return [...s];
    },
    can(permission, bid) {
      return hasPermission(assignments, permission, bid);
    },
    require(permission, bid) {
      if (!hasPermission(assignments, permission, bid))
        throw new HttpsError('permission-denied', `You do not have the "${permission}" permission for ${bid}.`);
    },
    requireBarangay(bid) {
      if (!canAccessBarangay(assignments, bid)) throw new HttpsError('permission-denied', `You do not have access to ${bid}.`);
    },
  };
  return ctx;
}

export function toHttpsError(e: unknown): HttpsError {
  if (e instanceof HttpsError) return e;
  if (e instanceof BfmsError) {
    const code =
      e.code === 'SEGREGATION_OF_DUTIES' || e.code === 'BARANGAY_MISMATCH'
        ? 'permission-denied'
        : e.code === 'ALREADY_POSTED' || e.code === 'DUPLICATE_NUMBER'
          ? 'already-exists'
          : 'failed-precondition';
    return new HttpsError(code, e.message, { code: e.code, ...(e.details ?? {}) });
  }
  console.error('Unhandled error', e);
  return new HttpsError('internal', 'An unexpected error occurred. The incident was logged.');
}
