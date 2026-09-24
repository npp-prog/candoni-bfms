import {
  BARANGAY_IDS,
  COL,
  assertPeriodTransition,
  periodDocId,
  periodKey,
  type AccountingPeriodDoc,
  type BarangayId,
  type FiscalYearDoc,
  type PeriodStatus,
} from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';
import type { CallerContext } from '../lib/context';
import type { Transaction } from 'firebase-admin/firestore';

const barangaySchema = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const yearSchema = z.number().int().min(2000).max(2100);

/** Create the municipality-wide fiscal year (Jan 1 – Dec 31). */
export const createFiscalYear = secureCallable(z.object({ fiscalYear: yearSchema }), async ({ fiscalYear }, ctx) => {
  ctx.require('fiscalYear.manage', 'ALL');
  const ref = db.collection(COL.fiscalYears).doc(String(fiscalYear));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) throw new HttpsError('already-exists', `Fiscal year ${fiscalYear} already exists.`);
    const audit = await AuditWriter.begin(tx, ctx, 'SYSTEM');
    const doc: FiscalYearDoc = {
      fiscalYear,
      status: 'SETUP',
      openingDate: `${fiscalYear}-01-01`,
      closingDate: `${fiscalYear}-12-31`,
      createdAt: Timestamp.now(),
      createdBy: ctx.uid,
      closedAt: null,
      closedBy: null,
    };
    tx.create(ref, doc);
    audit.write({ module: 'fiscalYears', recordId: ref.id, action: 'CREATE', newValue: { fiscalYear, status: 'SETUP' }, source: 'callable:createFiscalYear' });
    audit.commit();
  });
  return { fiscalYear };
});

/**
 * Open a fiscal year for one barangay: creates barangayFiscalYears/{bid}_{fy} and 14 periods
 * (00 opening … 12, 13 closing). Months 00–12 start OPEN; 13 starts LOCKED until year-end.
 */
export const openBarangayFiscalYear = secureCallable(
  z.object({ barangayId: barangaySchema, fiscalYear: yearSchema }),
  async ({ barangayId, fiscalYear }, ctx) => {
    ctx.require('fiscalYear.manage', barangayId);
    const fyRef = db.collection(COL.fiscalYears).doc(String(fiscalYear));
    const bfyRef = db.collection(COL.barangayFiscalYears).doc(`${barangayId}_${fiscalYear}`);
    await db.runTransaction(async (tx) => {
      const [fy, bfy] = await Promise.all([tx.get(fyRef), tx.get(bfyRef)]);
      if (!fy.exists) throw new HttpsError('failed-precondition', `Create fiscal year ${fiscalYear} first.`);
      if (fy.get('status') === 'CLOSED') throw new HttpsError('failed-precondition', `Fiscal year ${fiscalYear} is closed.`);
      if (bfy.exists) throw new HttpsError('already-exists', `${barangayId} ${fiscalYear} is already open.`);
      const audit = await AuditWriter.begin(tx, ctx, barangayId);
      const now = Timestamp.now();
      tx.create(bfyRef, { barangayId, fiscalYear, status: 'OPEN', openingBalancesPosted: false, openedAt: now, openedBy: ctx.uid, closedAt: null, closedBy: null });
      if (fy.get('status') === 'SETUP') tx.update(fyRef, { status: 'OPEN' });
      for (let m = 0; m <= 13; m++) {
        const p: AccountingPeriodDoc = {
          barangayId,
          fiscalYear,
          month: m,
          periodCode: periodKey(fiscalYear, m),
          status: m === 13 ? 'LOCKED' : 'OPEN',
          lockedAt: null,
          lockedBy: null,
          reopenedAt: null,
          reopenedBy: null,
          reopenReason: null,
          history: [],
        };
        tx.create(db.collection(COL.accountingPeriods).doc(periodDocId(barangayId, fiscalYear, m)), p);
      }
      audit.write({ module: 'barangayFiscalYears', recordId: bfyRef.id, action: 'CREATE', newValue: { status: 'OPEN', periods: 14 }, source: 'callable:openBarangayFiscalYear' });
      audit.commit();
    });
    return { ok: true };
  },
);

const periodInput = z.object({
  barangayId: barangaySchema,
  fiscalYear: yearSchema,
  month: z.number().int().min(0).max(13),
  reason: z.string().max(1000).optional(),
});

async function transitionPeriod(
  input: z.infer<typeof periodInput>,
  to: PeriodStatus,
  ctx: CallerContext,
  action: 'LOCK_PERIOD' | 'REOPEN_PERIOD' | 'EDIT',
  preCheck?: (tx: Transaction, p: AccountingPeriodDoc) => Promise<void>,
) {
  const ref = db.collection(COL.accountingPeriods).doc(periodDocId(input.barangayId, input.fiscalYear, input.month));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Accounting period not found. Open the fiscal year first.');
    const p = snap.data() as AccountingPeriodDoc;
    assertPeriodTransition(p.status, to, input.reason);
    if (preCheck) await preCheck(tx, p);
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const patch: Partial<AccountingPeriodDoc> & Record<string, unknown> = {
      status: to,
      history: [...(p.history ?? []), { from: p.status, to, by: ctx.uid, at: now, reason: input.reason ?? null }],
    };
    if (to === 'LOCKED') Object.assign(patch, { lockedAt: now, lockedBy: ctx.uid });
    if (p.status === 'LOCKED' && to === 'OPEN') Object.assign(patch, { reopenedAt: now, reopenedBy: ctx.uid, reopenReason: input.reason });
    tx.update(ref, patch);
    writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: 'accountingPeriods', recordId: ref.id, fromStatus: p.status, toStatus: to, remarks: input.reason ?? null });
    audit.write({ module: 'accountingPeriods', recordId: ref.id, action, oldValue: { status: p.status }, newValue: { status: to }, reason: input.reason ?? null, source: `callable:${action}` });
    audit.commit();
    return { periodId: ref.id, status: to };
  });
}

/** OPEN → REVIEW (month-end submission received) or REVIEW → OPEN (returned). */
export const setPeriodReview = secureCallable(periodInput.extend({ review: z.boolean() }), async (input, ctx) => {
  ctx.require('period.lock', input.barangayId);
  // Only OPEN⇄REVIEW here. LOCKED→OPEN must go through reopenAccountingPeriod (MA-only, stale-report flagging).
  return transitionPeriod(input, input.review ? 'REVIEW' : 'OPEN', ctx, 'EDIT', async (_tx, p) => {
    if (p.status !== (input.review ? 'OPEN' : 'REVIEW'))
      throw new HttpsError('failed-precondition', `Period is ${p.status}; use Reopen for locked periods.`);
  });
});

/**
 * Lock checklist (04 §19): no APPROVED-but-unposted JEVs in the period.
 * TB balance and bank reconciliation checks are added in Phases 8–9.
 */
export const lockAccountingPeriod = secureCallable(periodInput, async (input, ctx) => {
  ctx.require('period.lock', input.barangayId);
  return transitionPeriod(input, 'LOCKED', ctx, 'LOCK_PERIOD', async (tx, p) => {
    const pending = await tx.get(
      db
        .collection(COL.journalEntries)
        .where('barangayId', '==', input.barangayId)
        .where('fiscalYear', '==', input.fiscalYear)
        .where('accountingPeriod', '==', p.periodCode)
        .where('status', 'in', ['FOR_REVIEW', 'APPROVED'])
        .limit(1),
    );
    if (!pending.empty)
      throw new HttpsError('failed-precondition', `There are journal entries still in review or approved but not posted for ${p.periodCode}.`);
  });
});

/** LOCKED → OPEN. Municipal Accountant only; justification mandatory (validated in shared). */
export const reopenAccountingPeriod = secureCallable(periodInput.extend({ reason: z.string().min(10).max(1000) }), async (input, ctx) => {
  ctx.require('period.reopen', input.barangayId);
  const result = await transitionPeriod(input, 'OPEN', ctx, 'REOPEN_PERIOD');
  // Flag FINAL reports of this period as stale (a new version must be generated after relock).
  const finals = await db
    .collection(COL.generatedReports)
    .where('barangayId', '==', input.barangayId)
    .where('fiscalYear', '==', input.fiscalYear)
    .where('status', '==', 'FINAL')
    .where('reportingPeriod.to', '>=', periodKey(input.fiscalYear, input.month))
    .get();
  if (!finals.empty) {
    const b = db.batch();
    finals.docs.forEach((d) => b.update(d.ref, { staleSource: true }));
    await b.commit();
  }
  return { ...result, staleReports: finals.size };
});
