import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  assertIsoDate,
  assertPeriodAllowsEncoding,
  lastDayOfMonth,
  periodDocId,
  periodOfDate,
  validateJournalBalance,
  type AccountBalanceDoc,
  type BarangayId,
  type Centavos,
  type JournalEntryDoc,
  type JournalLineDoc,
  type LegacyCashAdvanceDoc,
  type PeriodStatus,
  type PpeScheduleDoc,
  type SubsidiaryAccountDoc,
} from '@bfms/shared';
import type { DocumentReference, DocumentSnapshot, QuerySnapshot } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
// Not re-exported from @bfms/shared's index (registry owned elsewhere); bundled by esbuild.
import {
  computePpeSchedule,
  depreciationJevLines,
  depreciationRunId,
  isCaScheduleAccount,
  isDepreciablePpeAccount,
  ppeGlFigures,
} from '../../../../shared/src/accounting/schedules';
import { AuditWriter } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';

/**
 * The accountant's schedules (docs: barangay books kept by the Municipal Accounting Office):
 *   - legacyCashAdvances — advances granted before BFMS that make up the opening SL balance
 *   - ppeSchedules/{bid}_{fy} — depreciation parameters per PPE account
 *   - depreciationRuns/{bid}_{fy}_{YR|mm} — source of the generated depreciation JEV
 * Every write is audited in the same transaction; permission jev.prepare at the barangay.
 */

const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
const fiscalYear = z.number().int().min(2000).max(2100);
const ref = z.string().trim().max(60).nullish().transform((s) => (s ? s : null));

// ------------------------------------------------------------------ legacy cash advances

export const saveLegacyCashAdvance = secureCallable(
  z.object({
    id: z.string().max(128).nullish(),
    barangayId: barangay,
    fiscalYear,
    accountCode,
    subsidiaryId: z.string().max(160).nullish().transform((s) => s || null),
    officerName: z.string().trim().max(160).default(''),
    date: z.string(),
    checkNumber: ref,
    dvNumber: ref,
    particulars: z.string().trim().min(2).max(500),
    /** Outstanding as of the opening date; negative = over-liquidated. */
    amount: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= Number.MAX_SAFE_INTEGER, 'Amount must not be zero.'),
    source: z.string().trim().max(200).default('Manual entry'),
  }),
  async (input, ctx) => {
    ctx.require('jev.prepare', input.barangayId);
    const date = assertIsoDate(input.date, 'date');
    if (!isCaScheduleAccount(input.accountCode))
      throw new BfmsError('INVALID_ACCOUNT', `${input.accountCode} is not a cash advance account (1-03-03-010, 1-03-03-020, 1-03-04-0xx).`);
    if (date > `${input.fiscalYear}-12-31`) throw new BfmsError('VALIDATION_FAILED', 'A legacy advance must be dated on or before the end of the fiscal year.');
    const docRef = input.id ? db.collection(COL.legacyCashAdvances).doc(input.id) : db.collection(COL.legacyCashAdvances).doc();
    return db.runTransaction(async (tx) => {
      const [snap, slSnap] = await Promise.all([
        input.id ? tx.get(docRef) : Promise.resolve(null),
        input.subsidiaryId ? tx.get(db.collection(COL.subsidiaryAccounts).doc(input.subsidiaryId)) : Promise.resolve(null),
      ]);
      if (input.id && !snap?.exists) throw new HttpsError('not-found', 'Legacy cash advance not found.');
      const cur = snap?.exists ? (snap.data() as LegacyCashAdvanceDoc) : null;
      if (cur && cur.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'Barangay cannot be changed.');
      let officerName = input.officerName;
      if (slSnap) {
        const sl = slSnap.data() as SubsidiaryAccountDoc | undefined;
        if (!sl) throw new BfmsError('SUBSIDIARY_MISMATCH', `Subsidiary ledger ${input.subsidiaryId} does not exist.`);
        if (sl.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The subsidiary ledger belongs to another barangay.');
        if (sl.accountCode !== input.accountCode) throw new BfmsError('SUBSIDIARY_MISMATCH', `Subsidiary ${input.subsidiaryId} is controlled by ${sl.accountCode}, not ${input.accountCode}.`);
        officerName ||= sl.subsidiaryName;
      }
      if (officerName.length < 2) throw new BfmsError('VALIDATION_FAILED', 'Enter the accountable officer (or pick the subsidiary ledger).');
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const data: LegacyCashAdvanceDoc & { updatedAt: Timestamp; updatedBy: string } = {
        barangayId: input.barangayId,
        fiscalYear: input.fiscalYear,
        accountCode: input.accountCode,
        subsidiaryId: input.subsidiaryId,
        officerName,
        date,
        checkNumber: input.checkNumber,
        dvNumber: input.dvNumber,
        particulars: input.particulars,
        amount: input.amount as Centavos,
        source: cur?.source ?? input.source,
        createdAt: cur?.createdAt ?? now,
        createdBy: cur?.createdBy ?? ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.set(docRef, data);
      const { createdAt: _c, updatedAt: _u, ...logged } = data;
      audit.write({ module: COL.legacyCashAdvances, recordId: docRef.id, action: cur ? 'EDIT' : 'CREATE', oldValue: cur ? { amount: cur.amount, date: cur.date, accountCode: cur.accountCode, subsidiaryId: cur.subsidiaryId } : null, newValue: logged, source: 'callable:saveLegacyCashAdvance' });
      audit.commit();
      return { id: docRef.id };
    });
  },
);

export const deleteLegacyCashAdvance = secureCallable(z.object({ id: z.string().min(1).max(128), reason: z.string().trim().max(500).optional() }), async (input, ctx) => {
  const docRef = db.collection(COL.legacyCashAdvances).doc(input.id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Legacy cash advance not found.');
    const cur = snap.data() as LegacyCashAdvanceDoc;
    ctx.require('jev.prepare', cur.barangayId);
    const audit = await AuditWriter.begin(tx, ctx, cur.barangayId);
    tx.delete(docRef);
    const { createdAt: _c, ...logged } = cur;
    audit.write({ module: COL.legacyCashAdvances, recordId: input.id, action: 'VOID', oldValue: logged, newValue: null, reason: input.reason ?? 'Deleted from the cash advance schedule', source: 'callable:deleteLegacyCashAdvance' });
    audit.commit();
    return { ok: true };
  });
});

// ------------------------------------------------------------------ PPE schedule

const ppeRow = z.object({
  accountCode,
  costOverride: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  residualRateBp: z.number().int().min(0).max(10_000),
  usefulLifeYears: z.number().int().min(1).max(100),
  accumulatedAccountCode: accountCode,
  expenseAccountCode: accountCode,
  remarks: z.string().trim().max(300).default(''),
});

export const savePpeSchedule = secureCallable(z.object({ barangayId: barangay, fiscalYear, rows: z.array(ppeRow).max(150) }), async (input, ctx) => {
  ctx.require('jev.prepare', input.barangayId);
  const seen = new Set<string>();
  for (const r of input.rows) {
    if (seen.has(r.accountCode)) throw new BfmsError('VALIDATION_FAILED', `${r.accountCode} appears twice in the schedule.`);
    seen.add(r.accountCode);
    if (!isDepreciablePpeAccount(r.accountCode)) throw new BfmsError('INVALID_ACCOUNT', `${r.accountCode} is not a depreciable PPE account (1-07-xx-xx0; land and construction in progress are not depreciated).`);
    if (!/^1-07-\d{2}-\d{2}1$/.test(r.accumulatedAccountCode)) throw new BfmsError('INVALID_ACCOUNT', `${r.accountCode}: ${r.accumulatedAccountCode} is not an accumulated depreciation account (1-07-xx-xx1).`);
    if (!r.expenseAccountCode.startsWith('5-04-01-')) throw new BfmsError('INVALID_ACCOUNT', `${r.accountCode}: ${r.expenseAccountCode} is not a depreciation expense account (5-04-01-xxx).`);
  }
  const docRef = db.collection(COL.ppeSchedules).doc(`${input.barangayId}_${input.fiscalYear}`);
  const codes = [...new Set(input.rows.flatMap((r) => [r.accountCode, r.accumulatedAccountCode, r.expenseAccountCode]))];
  return db.runTransaction(async (tx) => {
    const [snap, ...accts] = await Promise.all([tx.get(docRef), ...codes.map((c) => tx.get(db.collection(COL.chartOfAccounts).doc(c)))]);
    const missing = accts.filter((a) => !a.exists).map((a) => a.id);
    if (missing.length) throw new BfmsError('INVALID_ACCOUNT', `Not in the Chart of Accounts: ${missing.join(', ')}.`);
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const rows = [...input.rows].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    const data: PpeScheduleDoc = { barangayId: input.barangayId, fiscalYear: input.fiscalYear, rows, updatedAt: now, updatedBy: ctx.uid };
    tx.set(docRef, data);
    audit.write({ module: COL.ppeSchedules, recordId: docRef.id, action: snap.exists ? 'EDIT' : 'CREATE', oldValue: snap.exists ? { rows: (snap.data() as PpeScheduleDoc).rows } : null, newValue: { rows }, source: 'callable:savePpeSchedule' });
    audit.commit();
    return { id: docRef.id, rows: rows.length };
  });
});

// ------------------------------------------------------------------ depreciation JEV

interface DepreciationScheduleRun {
  barangayId: BarangayId;
  fiscalYear: number;
  kind: 'PPE_SCHEDULE';
  /** `${fy}-YR` (year, Dec 31) or `${fy}-MM`. */
  period: string;
  month: number | null;
  jevId: string;
  jevNumber: string | null;
  jevDate: string;
  totalDepreciation: Centavos;
  rows: Array<{ accountCode: string; amount: Centavos }>;
  replacedJevIds: string[];
}

const UNPOSTED = ['DRAFT', 'FOR_REVIEW', 'RETURNED', 'APPROVED'];

/**
 * Generate the depreciation entry for the year (one entry dated Dec 31, as the legacy books do)
 * or for one month: Dr each depreciation expense account / Cr each accumulated depreciation
 * account, consolidated, as a DRAFT JEV (GJ, transaction type OTHERS) linked to
 * depreciationRuns/{bid}_{fy}_{YR|mm}. A second run for the same period is refused unless the
 * previous JEV is still unposted and `replace` is true (it is then deleted and regenerated);
 * year and monthly runs are not mixed in the same fiscal year.
 */
export const generateDepreciationJev = secureCallable(
  z.object({ barangayId: barangay, fiscalYear, month: z.number().int().min(1).max(12).nullish(), replace: z.boolean().default(false) }),
  async (input, ctx) => {
    ctx.require('jev.prepare', input.barangayId);
    const bid = input.barangayId;
    const fy = input.fiscalYear;
    const month = input.month ?? null;
    const runId = depreciationRunId(bid, fy, month);
    const runRef = db.collection('depreciationRuns').doc(runId);
    const jevDate = month ? lastDayOfMonth(fy, month) : `${fy}-12-31`;
    const { key } = periodOfDate(jevDate);
    const jevMonth = month ?? 12;
    const label = month ? `the month of ${new Date(Date.UTC(fy, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${fy}` : `the year ${fy}`;

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE
      const [runSnap, periodSnap, schedSnap, balSnap, otherRuns] = await Promise.all([
        tx.get(runRef),
        tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(bid, fy, jevMonth))),
        tx.get(db.collection(COL.ppeSchedules).doc(`${bid}_${fy}`)),
        tx.get(db.collection(COL.accountBalances).where('barangayId', '==', bid).where('fiscalYear', '==', fy)),
        tx.get(db.collection('depreciationRuns').where('barangayId', '==', bid).where('fiscalYear', '==', fy)),
      ]);
      assertPeriodAllowsEncoding(periodSnap.get('status') as PeriodStatus | undefined);
      if (!schedSnap.exists) throw new BfmsError('VALIDATION_FAILED', `Save the PPE depreciation schedule for ${fy} first.`);
      const sched = schedSnap.data() as PpeScheduleDoc;

      // Year and monthly runs must not overlap (they would depreciate the same months twice).
      const live = async (snap: DocumentSnapshot) => {
        const r = snap.data() as Partial<DepreciationScheduleRun> | undefined;
        if (!r?.jevId) return null;
        const j = await tx.get(db.collection(COL.journalEntries).doc(r.jevId));
        return { run: r, jevRef: j.ref, jev: j.exists ? (j.data() as JournalEntryDoc) : null };
      };
      const conflicting = (otherRuns as QuerySnapshot).docs.filter((d) => d.id !== runId && (d.get('kind') === 'PPE_SCHEDULE' || d.get('jevId')) && (month === null ? true : d.id.endsWith('_YR')));
      for (const d of conflicting) {
        const o = await live(d);
        if (o?.jev && o.jev.status !== 'REVERSED')
          throw new BfmsError('ALREADY_POSTED', month === null ? `Monthly depreciation was already generated for ${fy} (${d.id}); the year-end entry would double it.` : `The year-end depreciation for ${fy} was already generated; monthly runs would double it.`, { runId: d.id });
      }
      const prev = runSnap.exists ? await live(runSnap) : null;
      let oldLines: QuerySnapshot | null = null;
      if (prev?.jev) {
        if (prev.jev.status === 'POSTED')
          throw new BfmsError('ALREADY_POSTED', `Depreciation for ${label} was already recorded (JEV ${prev.jev.jevNumber ?? prev.run.jevId}). Reverse that entry first to regenerate it.`, { jevId: prev.run.jevId });
        if (UNPOSTED.includes(prev.jev.status)) {
          if (!input.replace)
            throw new BfmsError('DUPLICATE_NUMBER', `A depreciation entry for ${label} already exists (${prev.jev.status}). Choose "replace" to regenerate it from the current schedule.`, { jevId: prev.run.jevId, status: prev.jev.status });
          oldLines = await tx.get(prev.jevRef.collection(COL.lines));
        } else if (!input.replace) {
          throw new BfmsError('DUPLICATE_NUMBER', `A depreciation run for ${label} exists (JEV ${prev.jev.status}). Choose "replace" to generate a new entry.`, { jevId: prev.run.jevId });
        }
      }

      const balances = balSnap.docs.map((d) => d.data() as AccountBalanceDoc).filter((b) => b.accountCode.startsWith('1-07-'));
      const rows = sched.rows.filter((r) => isDepreciablePpeAccount(r.accountCode));
      const gl = ppeGlFigures(rows, balances, { costMonth: jevMonth, fromMonth: month ?? 1, toMonth: jevMonth });
      const computed = computePpeSchedule(rows, gl, month ? 'MONTH' : 'YEAR');
      const lines = depreciationJevLines(computed);
      if (!lines.length) throw new BfmsError('EMPTY_ENTRY', `Nothing to depreciate for ${label}: no PPE cost on the books, or the assets are fully depreciated.`);
      const totals = validateJournalBalance(lines);
      const audit = await AuditWriter.begin(tx, ctx, bid);

      // ---- WRITE PHASE
      const now = Timestamp.now();
      if (prev?.jev && oldLines) {
        oldLines.docs.forEach((d) => tx.delete(d.ref));
        tx.delete(prev.jevRef);
        audit.write({ module: 'journalEntries', recordId: prev.run.jevId!, action: 'CANCEL', oldValue: { status: prev.jev.status, totalDebit: prev.jev.totalDebit }, newValue: null, reason: 'Replaced by a regenerated depreciation entry', source: 'callable:generateDepreciationJev' });
      }
      const jevRef: DocumentReference = db.collection(COL.journalEntries).doc();
      const particulars = `To record depreciation of PPE for ${label}`;
      const header: Omit<JournalEntryDoc, 'submittedBy'> = {
        barangayId: bid,
        fiscalYear: fy,
        accountingPeriod: key,
        jevNumber: null,
        jevDate,
        fundId: 'GF',
        journal: 'GJ',
        entryType: 'REGULAR',
        sourceModule: 'DEPRECIATION',
        sourceDocumentId: runId,
        primaryReference: null,
        secondaryReference: null,
        tertiaryReference: null,
        particulars,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lineCount: lines.length,
        reversesJevId: null,
        reversedByJevId: null,
        transactionType: 'OTHERS',
        payeeName: null,
        status: 'DRAFT',
        revisionNumber: 0,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.create(jevRef, header);
      lines.forEach((l, i) => {
        const line: JournalLineDoc = {
          barangayId: bid,
          fiscalYear: fy,
          accountingPeriod: key,
          fundId: 'GF',
          jevId: jevRef.id,
          jevDate,
          jevNumber: null,
          journal: 'GJ',
          entryType: 'REGULAR',
          posted: false,
          lineNo: i + 1,
          accountCode: l.accountCode,
          subsidiaryId: null,
          debit: l.debit,
          credit: l.credit,
          lineDescription: l.debit ? 'Depreciation expense' : 'Accumulated depreciation',
          primaryReference: null,
          secondaryReference: null,
          payeeName: null,
          fppId: null,
          officeId: null,
        };
        tx.set(jevRef.collection(COL.lines).doc(String(i + 1).padStart(3, '0')), line);
      });
      const run: DepreciationScheduleRun & { createdAt: Timestamp; createdBy: string; updatedAt: Timestamp; updatedBy: string } = {
        barangayId: bid,
        fiscalYear: fy,
        kind: 'PPE_SCHEDULE',
        period: `${fy}-${month ? String(month).padStart(2, '0') : 'YR'}`,
        month,
        jevId: jevRef.id,
        jevNumber: null,
        jevDate,
        totalDepreciation: totals.totalDebit,
        rows: computed.filter((r) => r.periodDepreciation > 0).map((r) => ({ accountCode: r.accountCode, amount: r.periodDepreciation })),
        replacedJevIds: [...((prev?.run.replacedJevIds as string[] | undefined) ?? []), ...(prev?.run.jevId ? [prev.run.jevId] : [])],
        createdAt: (runSnap.get('createdAt') as Timestamp | undefined) ?? now,
        createdBy: (runSnap.get('createdBy') as string | undefined) ?? ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.set(runRef, run);
      audit.write({ module: 'journalEntries', recordId: jevRef.id, action: 'GENERATE', newValue: { sourceModule: 'DEPRECIATION', runId, jevDate, totalDebit: totals.totalDebit, lineCount: lines.length }, source: 'callable:generateDepreciationJev' });
      audit.commit();
      return { jevId: jevRef.id, runId, totalDepreciation: totals.totalDebit, lines: lines.length, replaced: prev?.run.jevId ?? null };
    });
  },
);
