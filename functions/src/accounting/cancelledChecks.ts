import { BARANGAY_IDS, COL, assertIsoDate, uniqueKeyId, type BarangayId } from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';

/**
 * Cancelled / spoiled checks. The legacy journal kept them as zero-amount lines so the check series
 * stays complete; BFMS keeps them in `cancelledChecks/{bid}_{bankAccountId}_{checkNumber}` instead
 * (a JEV cannot total zero). The Checks Issued report and Schedule 1 list them at 0.00.
 */
const input = z.object({
  barangayId: z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]),
  bankAccountId: z.string().min(1).max(128),
  checkNumber: z.string().trim().regex(/^[0-9A-Za-z-]{3,20}$/, 'Enter the check number as printed.'),
  checkDate: z.string(),
  payeeName: z.string().trim().max(200).nullish(),
  remarks: z.string().trim().max(500).default('Cancelled check'),
});

export const recordCancelledCheck = secureCallable(input, async (inp, ctx) => {
  ctx.require('jev.prepare', inp.barangayId);
  const date = assertIsoDate(inp.checkDate, 'checkDate');
  const id = uniqueKeyId('CXL', inp.barangayId, inp.bankAccountId, inp.checkNumber);
  const ref = db.collection(COL.cancelledChecks).doc(id);
  await db.runTransaction(async (tx) => {
    const [snap, bank] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.bankAccounts).doc(inp.bankAccountId))]);
    if (!bank.exists || bank.get('barangayId') !== inp.barangayId) throw new HttpsError('failed-precondition', 'Bank account not found for this barangay.');
    if (snap.exists) throw new HttpsError('already-exists', `Check ${inp.checkNumber} is already recorded as cancelled.`);
    const audit = await AuditWriter.begin(tx, ctx, inp.barangayId);
    const now = Timestamp.now();
    tx.create(ref, { ...inp, checkDate: date, fiscalYear: Number(date.slice(0, 4)), payeeName: inp.payeeName ?? null, createdAt: now, createdBy: ctx.uid, updatedAt: now, updatedBy: ctx.uid });
    audit.write({ module: COL.cancelledChecks, recordId: id, action: 'CANCEL', newValue: { checkNumber: inp.checkNumber, checkDate: date }, reason: inp.remarks, source: 'callable:recordCancelledCheck' });
    audit.commit();
  });
  return { id };
});

/** Remove an entry recorded by mistake (the check was actually issued). Reason required, audited. */
export const deleteCancelledCheck = secureCallable(z.object({ id: z.string().min(1).max(200), reason: z.string().trim().min(5).max(500) }), async (inp, ctx) => {
  const ref = db.collection(COL.cancelledChecks).doc(inp.id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Cancelled check not found.');
    const bid = snap.get('barangayId') as BarangayId;
    ctx.require('jev.prepare', bid);
    const audit = await AuditWriter.begin(tx, ctx, bid);
    tx.delete(ref);
    audit.write({ module: COL.cancelledChecks, recordId: inp.id, action: 'EDIT', oldValue: snap.data() ?? null, newValue: null, reason: inp.reason, source: 'callable:deleteCancelledCheck' });
    audit.commit();
  });
  return { ok: true };
});
