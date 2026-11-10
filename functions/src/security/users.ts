import {
  BARANGAY_IDS,
  COL,
  PRIVILEGED_ROLES,
  ROLE_CODES,
  isRoleAllowedAtScope,
  manilaToday,
  type RoleCode,
  type UserAssignmentDoc,
  type UserDoc,
} from '@bfms/shared';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuditWriter } from '../audit/auditWriter';
import { adminAuth, db, REGION, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';
import type { CallerContext } from '../lib/context';
import { syncClaimsForUser } from './claims';

const scopeSchema = z.enum(['ALL', ...BARANGAY_IDS] as [string, ...string[]]);
const roleSchema = z.enum(ROLE_CODES as [RoleCode, ...RoleCode[]]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function assertCanGrant(ctx: CallerContext, roles: RoleCode[], targetUid: string) {
  ctx.require('admin.users.manage', 'ALL');
  if (targetUid === ctx.uid) throw new HttpsError('permission-denied', 'You cannot change your own roles.');
  const isSuperAdmin = ctx.rolesAt('ALL').includes('super_admin');
  const privileged = roles.filter((r) => PRIVILEGED_ROLES.includes(r));
  if (privileged.length && !isSuperAdmin)
    throw new HttpsError('permission-denied', `Only a Super Admin may grant: ${privileged.join(', ')}.`);
}

/** Create a BFMS user (Auth + users/{uid}). The client then triggers a password-reset email. */
export const createUserAccount = secureCallable(
  z.object({
    email: z.string().email().toLowerCase(),
    displayName: z.string().min(3).max(120),
    position: z.string().max(120).default(''),
    defaultBarangayId: scopeSchema.nullable().default(null),
  }),
  async (input, ctx) => {
    ctx.require('admin.users.manage', 'ALL');
    let uid: string;
    try {
      const u = await adminAuth.createUser({ email: input.email, displayName: input.displayName, emailVerified: false, disabled: false });
      uid = u.uid;
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'A user with that email already exists.');
      throw e;
    }
    await db.runTransaction(async (tx) => {
      const audit = await AuditWriter.begin(tx, ctx, 'SYSTEM');
      const now = Timestamp.now();
      tx.create(db.collection(COL.users).doc(uid), {
        uid,
        email: input.email,
        displayName: input.displayName,
        position: input.position,
        active: true,
        defaultBarangayId: input.defaultBarangayId,
        claimsVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      audit.write({ module: 'users', recordId: uid, action: 'CREATE', newValue: { email: input.email, displayName: input.displayName }, source: 'callable:createUserAccount' });
      audit.commit();
    });
    return { uid };
  },
);

/** Create or replace a user's roles at one scope (barangay or ALL). */
export const setUserAssignment = secureCallable(
  z.object({
    uid: z.string().min(1),
    barangayId: scopeSchema,
    roles: z.array(roleSchema).min(1).max(6),
    validFrom: isoDate.optional(),
    validTo: isoDate.nullable().optional(),
    remarks: z.string().max(500).optional(),
  }),
  async (input, ctx) => {
    assertCanGrant(ctx, input.roles, input.uid);
    for (const r of input.roles)
      if (!isRoleAllowedAtScope(r, input.barangayId))
        throw new HttpsError('invalid-argument', `Role ${r} cannot be assigned at scope ${input.barangayId}.`);

    const userRef = db.collection(COL.users).doc(input.uid);
    const existingQ = db.collection(COL.userAssignments).where('uid', '==', input.uid).where('barangayId', '==', input.barangayId).where('active', '==', true);

    const assignmentId = await db.runTransaction(async (tx) => {
      const user = await tx.get(userRef);
      if (!user.exists) throw new HttpsError('not-found', 'User not found.');
      const existing = await tx.get(existingQ);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId as never);
      const now = Timestamp.now();
      const before = existing.docs.map((d) => d.data() as UserAssignmentDoc);
      existing.docs.forEach((d) => tx.update(d.ref, { active: false, validTo: manilaToday(), updatedAt: now, updatedBy: ctx.uid }));
      const ref = db.collection(COL.userAssignments).doc();
      const doc: UserAssignmentDoc = {
        uid: input.uid,
        barangayId: input.barangayId as UserAssignmentDoc['barangayId'],
        roles: [...new Set(input.roles)],
        active: true,
        validFrom: input.validFrom ?? manilaToday(),
        validTo: input.validTo ?? null,
        remarks: input.remarks ?? '',
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.create(ref, doc);
      if ((user.get('accessRequest') as UserDoc['accessRequest'])?.status === 'PENDING')
        tx.update(userRef, { 'accessRequest.status': 'APPROVED', 'accessRequest.decidedAt': now, updatedAt: now });
      audit.write({
        module: 'userAssignments',
        recordId: ref.id,
        action: 'CHANGE_ROLE',
        oldValue: before.length ? { roles: before.flatMap((b) => b.roles), barangayId: input.barangayId } : null,
        newValue: { uid: input.uid, roles: doc.roles, barangayId: doc.barangayId },
        reason: input.remarks ?? null,
        source: 'callable:setUserAssignment',
      });
      audit.commit();
      return ref.id;
    });
    const claims = await syncClaimsForUser(input.uid);
    return { assignmentId, claims };
  },
);

export const revokeUserAssignment = secureCallable(
  z.object({ assignmentId: z.string().min(1), reason: z.string().min(5).max(500) }),
  async (input, ctx) => {
    const ref = db.collection(COL.userAssignments).doc(input.assignmentId);
    const uid = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Assignment not found.');
      const a = snap.data() as UserAssignmentDoc;
      assertCanGrant(ctx, a.roles, a.uid);
      const audit = await AuditWriter.begin(tx, ctx, a.barangayId);
      tx.update(ref, { active: false, validTo: manilaToday(), updatedAt: Timestamp.now(), updatedBy: ctx.uid });
      audit.write({ module: 'userAssignments', recordId: ref.id, action: 'CHANGE_ROLE', oldValue: { roles: a.roles, active: true }, newValue: { active: false }, reason: input.reason, source: 'callable:revokeUserAssignment' });
      audit.commit();
      return a.uid;
    });
    await syncClaimsForUser(uid);
    return { ok: true };
  },
);

export const setUserActive = secureCallable(
  z.object({ uid: z.string().min(1), active: z.boolean(), reason: z.string().min(5).max(500) }),
  async (input, ctx) => {
    ctx.require('admin.users.manage', 'ALL');
    if (input.uid === ctx.uid) throw new HttpsError('permission-denied', 'You cannot deactivate yourself.');
    await adminAuth.updateUser(input.uid, { disabled: !input.active });
    if (!input.active) await adminAuth.revokeRefreshTokens(input.uid);
    await db.runTransaction(async (tx) => {
      const audit = await AuditWriter.begin(tx, ctx, 'SYSTEM');
      tx.update(db.collection(COL.users).doc(input.uid), { active: input.active, updatedAt: Timestamp.now() });
      audit.write({ module: 'users', recordId: input.uid, action: 'EDIT', newValue: { active: input.active }, reason: input.reason, source: 'callable:setUserActive' });
      audit.commit();
    });
    return { ok: true };
  },
);

/** Client calls this right after sign-in; records LOGIN and returns the fresh claims version. */
export const recordLogin = secureCallable(z.object({}).strict(), async (_input, ctx) => {
  await db.runTransaction(async (tx) => {
    const audit = await AuditWriter.begin(tx, ctx, 'SYSTEM', `LOGIN_${ctx.uid}`);
    tx.update(db.collection(COL.users).doc(ctx.uid), { lastLoginAt: Timestamp.now() });
    audit.write({ module: 'auth', recordId: ctx.uid, action: 'LOGIN', source: 'callable:recordLogin' });
    audit.commit();
  });
  return { assignments: ctx.assignments };
});

/**
 * Google sign-up: the first time a person signs in with Google, register them in BFMS with no
 * roles and an access request the Municipal Accountant sees under Administration → Users.
 * They can use BFMS only after a role is assigned (setUserAssignment). Idempotent.
 */
export const requestAccess = onCall({ region: REGION, timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  const token = req.auth.token;
  if (token.firebase?.sign_in_provider !== 'google.com') throw new HttpsError('failed-precondition', 'Access requests are made by signing in with Google.');
  if (!token.email || token.email_verified !== true) throw new HttpsError('failed-precondition', 'Your Google account has no verified email address.');
  const uid = req.auth.uid;
  const email = String(token.email).toLowerCase();
  const displayName = String(token.name ?? email.split('@')[0]).slice(0, 120);
  const ref = db.collection(COL.users).doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const u = snap.data() as UserDoc;
      return { status: u.accessRequest?.status ?? 'REGISTERED', active: u.active };
    }
    const ctx = { uid, userName: displayName, requestId: randomUUID(), rolesAt: () => [] as RoleCode[] };
    const audit = await AuditWriter.begin(tx, ctx, 'SYSTEM');
    const now = Timestamp.now();
    const doc: UserDoc = {
      uid,
      email,
      displayName,
      position: '',
      active: true,
      defaultBarangayId: null,
      claimsVersion: 0,
      accessRequest: { status: 'PENDING', provider: 'google.com', requestedAt: now, decidedAt: null },
      createdAt: now,
      updatedAt: now,
    };
    tx.create(ref, doc);
    audit.write({ module: 'users', recordId: uid, action: 'CREATE', newValue: { email, displayName, accessRequest: 'PENDING' }, source: 'callable:requestAccess' });
    audit.commit();
    return { status: 'PENDING', active: true };
  });
});
