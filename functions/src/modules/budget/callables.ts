import { BARANGAY_IDS, COL, type BarangayId } from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';

/**
 * REAI estimates: one document per barangay, year, fund and income account
 * (`estimatedIncome/{bid}_{fy}_{fund}_{account}`). Actual collections are derived in the REAI report.
 */
export const saveEstimatedIncome = secureCallable(
  z.object({
    barangayId: z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]),
    fiscalYear: z.number().int().min(2000).max(2100),
    fundId: z.string().min(1).max(60).default('GF'),
    incomeAccountCode: z.string().regex(/^4-\d{2}-\d{2}-\d{3}$/, 'Use a revenue account (4-xx-xx-xxx).'),
    estimatedIncome: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  async (input, ctx) => {
    ctx.require('budget.encode', input.barangayId);
    const id = `${input.barangayId}_${input.fiscalYear}_${input.fundId}_${input.incomeAccountCode}`;
    const ref = db.collection(COL.estimatedIncome).doc(id);
    await db.runTransaction(async (tx) => {
      const [snap, acct] = await Promise.all([tx.get(ref), tx.get(db.collection(COL.chartOfAccounts).doc(input.incomeAccountCode))]);
      if (!acct.exists) throw new HttpsError('failed-precondition', `Account ${input.incomeAccountCode} is not in the Chart of Accounts.`);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      tx.set(ref, { ...input, accountName: acct.get('accountName') as string, updatedAt: now, updatedBy: ctx.uid, ...(snap.exists ? {} : { createdAt: now, createdBy: ctx.uid }) }, { merge: true });
      audit.write({ module: COL.estimatedIncome, recordId: id, action: snap.exists ? 'EDIT' : 'CREATE', oldValue: snap.exists ? { estimatedIncome: snap.get('estimatedIncome') } : null, newValue: { estimatedIncome: input.estimatedIncome }, source: 'callable:saveEstimatedIncome' });
      audit.commit();
    });
    return { id };
  },
);
