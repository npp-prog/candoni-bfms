import {
  COL,
  manilaToday,
  roleToClaim,
  type BfmsClaims,
  type UserAssignmentDoc,
} from '@bfms/shared';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { adminAuth, db, FieldValue, REGION } from '../lib/admin';

/**
 * Rebuild the compact custom claim `{ a: { AGBOY: ['BT'] }, v }` from active assignments.
 * Claims are an optimization for Security Rules; functions re-read assignments on every call.
 */
export async function syncClaimsForUser(uid: string): Promise<BfmsClaims> {
  const today = manilaToday();
  const snap = await db.collection(COL.userAssignments).where('uid', '==', uid).where('active', '==', true).get();
  const a: Record<string, string[]> = {};
  for (const d of snap.docs) {
    const x = d.data() as UserAssignmentDoc;
    if (x.validFrom > today || (x.validTo && x.validTo < today)) continue;
    const set = new Set(a[x.barangayId] ?? []);
    x.roles.forEach((r) => set.add(roleToClaim(r)));
    a[x.barangayId] = [...set].sort();
  }
  const userRef = db.collection(COL.users).doc(uid);
  const v = await db.runTransaction(async (tx) => {
    const u = await tx.get(userRef);
    const next = ((u.get('claimsVersion') as number | undefined) ?? 0) + 1;
    tx.set(userRef, { claimsVersion: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });
  const claims: BfmsClaims = { a, v };
  const size = JSON.stringify(claims).length;
  if (size > 900) console.warn(`Custom claims for ${uid} are ${size} bytes (limit 1000).`);
  await adminAuth.setCustomUserClaims(uid, claims as unknown as Record<string, unknown>);
  // Revoke refresh tokens only when roles were removed would be stricter; we rely on the
  // client refreshing on claimsVersion change + functions reading assignments fresh.
  return claims;
}

/** Defense in depth: any assignment write (including console edits) re-syncs claims. */
export const onUserAssignmentWritten = onDocumentWritten(
  { region: REGION, document: `${COL.userAssignments}/{assignmentId}` },
  async (event) => {
    const uid = (event.data?.after.get('uid') ?? event.data?.before.get('uid')) as string | undefined;
    if (uid) await syncClaimsForUser(uid);
  },
);

/**
 * Daily claims re-sync (00:05 Asia/Manila) for assignments that START today or ENDED yesterday.
 * Without this, an expired assignment would remain in the ID-token claims (Security Rules would
 * keep granting access) and a future-dated one would never activate.
 */
export const resyncDatedAssignments = onSchedule(
  { region: REGION, schedule: '5 0 * * *', timeZone: 'Asia/Manila' },
  async () => {
    const today = manilaToday();
    const y = new Date(`${today}T00:00:00Z`);
    y.setUTCDate(y.getUTCDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    const [starting, ending] = await Promise.all([
      db.collection(COL.userAssignments).where('validFrom', '==', today).get(),
      db.collection(COL.userAssignments).where('validTo', '==', yesterday).get(),
    ]);
    const uids = new Set([...starting.docs, ...ending.docs].map((d) => d.get('uid') as string));
    for (const uid of uids) await syncClaimsForUser(uid);
    console.log(`Re-synced claims for ${uids.size} user(s).`);
  },
);
