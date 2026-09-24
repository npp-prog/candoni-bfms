import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  JEV_TRANSITIONS,
  MAX_JEV_LINES,
  assertIsoDate,
  assertPeriodAllowsEncoding,
  assertSegregation,
  computeJournalTotals,
  findTransition,
  periodDocId,
  periodOfDate,
  type BarangayId,
  type Centavos,
  type JournalEntryDoc,
  type JournalLineDoc,
  type PeriodStatus,
} from '@bfms/shared';
import type { QuerySnapshot } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';

const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const jevLineSchema = z.object({
  accountCode: z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/),
  subsidiaryId: z.string().max(120).nullable().default(null),
  debit: centavos,
  credit: centavos,
  lineDescription: z.string().max(500).default(''),
  fppId: z.string().max(60).nullable().default(null),
  officeId: z.string().max(60).nullable().default(null),
});

const draftSchema = z.object({
  jevId: z.string().optional(),
  barangayId: z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]),
  jevDate: z.string(),
  fundId: z.string().min(1).max(60).default('GF'),
  journal: z.enum(['JCT', 'GJ']),
  entryType: z.enum(['REGULAR', 'ADJUSTING', 'CORRECTING', 'OPENING']).default('REGULAR'),
  sourceModule: z.enum(['MANUAL', 'IMPORT']).default('MANUAL'),
  primaryReference: z.string().max(60).nullable().default(null),
  secondaryReference: z.string().max(60).nullable().default(null),
  tertiaryReference: z.string().max(60).nullable().default(null),
  particulars: z.string().min(3).max(2000),
  lines: z.array(jevLineSchema).min(2).max(MAX_JEV_LINES),
});

/**
 * Create or update a DRAFT/RETURNED manual JEV. Journal entries are server-write-only, so even
 * drafts go through this function (lines are fully replaced on each save).
 * Balance is NOT required to save a draft (preview shows the difference); it IS required to submit & post.
 */
export const saveJournalDraft = secureCallable(draftSchema, async (input, ctx) => {
  ctx.require('jev.prepare', input.barangayId);
  const jevDate = assertIsoDate(input.jevDate, 'jevDate');
  const { fiscalYear, month, key } = input.entryType === 'OPENING'
    ? { ...periodOfDate(jevDate), month: 0, key: `${jevDate.slice(0, 4)}-00` }
    : periodOfDate(jevDate);
  const periodRef = db.collection(COL.accountingPeriods).doc(periodDocId(input.barangayId, fiscalYear, month));
  const jevRef = input.jevId ? db.collection(COL.journalEntries).doc(input.jevId) : db.collection(COL.journalEntries).doc();

  await db.runTransaction(async (tx) => {
    const [period, existing] = await Promise.all([tx.get(periodRef), input.jevId ? tx.get(jevRef) : Promise.resolve(null)]);
    assertPeriodAllowsEncoding(period.get('status') as PeriodStatus | undefined);
    let oldLines: QuerySnapshot | null = null;
    if (existing) {
      if (!existing.exists) throw new HttpsError('not-found', 'Journal entry not found.');
      const cur = existing.data() as JournalEntryDoc;
      if (cur.barangayId !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'Barangay cannot be changed.');
      if (cur.status !== 'DRAFT' && cur.status !== 'RETURNED')
        throw new BfmsError('INVALID_STATUS', `A ${cur.status} journal entry cannot be edited.`);
      if (cur.sourceModule !== 'MANUAL' && cur.sourceModule !== 'IMPORT')
        throw new BfmsError('INVALID_STATUS', `This entry was generated from ${cur.sourceModule}. Correct the source document instead (account reclassification of generated entries arrives in Phase 8).`);
      oldLines = await tx.get(jevRef.collection(COL.lines));
    }
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const totals = computeJournalTotals(input.lines as { debit: Centavos; credit: Centavos }[]);
    const header: Partial<JournalEntryDoc> = {
      barangayId: input.barangayId,
      fiscalYear,
      accountingPeriod: key,
      jevDate,
      fundId: input.fundId,
      journal: input.journal,
      entryType: input.entryType,
      sourceModule: input.sourceModule,
      sourceDocumentId: null,
      primaryReference: input.primaryReference,
      secondaryReference: input.secondaryReference,
      tertiaryReference: input.tertiaryReference,
      particulars: input.particulars,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      lineCount: input.lines.length,
      updatedAt: now,
      updatedBy: ctx.uid,
    };
    if (!existing) {
      tx.create(jevRef, {
        ...header,
        jevNumber: null,
        status: 'DRAFT',
        revisionNumber: 0,
        reversesJevId: null,
        reversedByJevId: null,
        createdAt: now,
        createdBy: ctx.uid,
      });
    } else {
      tx.update(jevRef, header);
      // Reused line IDs are overwritten with set() below; delete only surplus old lines (one write per doc).
      oldLines?.docs.filter((d) => Number(d.id) > input.lines.length).forEach((d) => tx.delete(d.ref));
    }
    input.lines.forEach((l, i) => {
      const line: JournalLineDoc = {
        barangayId: input.barangayId,
        fiscalYear,
        accountingPeriod: key,
        fundId: input.fundId,
        jevId: jevRef.id,
        jevDate,
        jevNumber: null,
        journal: input.journal,
        entryType: input.entryType,
        posted: false,
        lineNo: i + 1,
        accountCode: l.accountCode,
        subsidiaryId: l.subsidiaryId,
        debit: l.debit as Centavos,
        credit: l.credit as Centavos,
        lineDescription: l.lineDescription,
        primaryReference: input.primaryReference,
        secondaryReference: input.secondaryReference,
        payeeName: null,
        fppId: l.fppId,
        officeId: l.officeId,
      };
      tx.set(jevRef.collection(COL.lines).doc(String(i + 1).padStart(3, '0')), line);
    });
    audit.write({
      module: 'journalEntries',
      recordId: jevRef.id,
      action: existing ? 'EDIT' : 'CREATE',
      newValue: { totalDebit: totals.totalDebit, totalCredit: totals.totalCredit, lineCount: input.lines.length, jevDate },
      source: 'callable:saveJournalDraft',
    });
    audit.commit();
  });
  return { jevId: jevRef.id };
});

const actionSchema = z.object({ jevId: z.string().min(1), remarks: z.string().max(1000).optional() });

/** Generic JEV status transition: SUBMIT (→FOR_REVIEW), APPROVE, RETURN. POST/REVERSE have dedicated functions. */
function jevTransition(action: 'SUBMIT' | 'APPROVE' | 'RETURN') {
  return secureCallable(actionSchema, async (input, ctx) => {
    const ref = db.collection(COL.journalEntries).doc(input.jevId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Journal entry not found.');
      const jev = snap.data() as JournalEntryDoc;
      const t = findTransition(JEV_TRANSITIONS, action, jev.status);
      ctx.require(t.permission, jev.barangayId);
      if (t.requiresReason && (!input.remarks || input.remarks.trim().length < 5))
        throw new HttpsError('invalid-argument', 'Please state the reason (at least 5 characters).');
      if (action === 'APPROVE') assertSegregation(jev.createdBy, ctx.uid, 'approve');
      if (action === 'SUBMIT') {
        const lines = await tx.get(ref.collection(COL.lines));
        const totals = computeJournalTotals(lines.docs.map((d) => d.data() as JournalLineDoc));
        if (!totals.balanced || totals.totalDebit === 0)
          throw new BfmsError('UNBALANCED_ENTRY', 'Total debits must equal total credits before submitting.', { ...totals });
      }
      const audit = await AuditWriter.begin(tx, ctx, jev.barangayId);
      const now = Timestamp.now();
      const patch: Record<string, unknown> = { status: t.to, updatedAt: now, updatedBy: ctx.uid };
      if (action === 'SUBMIT') Object.assign(patch, { submittedBy: ctx.uid, submittedAt: now });
      if (action === 'APPROVE') Object.assign(patch, { approvedBy: ctx.uid, approvedAt: now, reviewedBy: jev.reviewedBy ?? ctx.uid, reviewedAt: now });
      if (action === 'RETURN') {
        const info = {
          reasonForReturn: input.remarks!,
          requiredCorrection: input.remarks!,
          returnedBy: ctx.uid,
          returnedAt: now,
          assignedTo: jev.createdBy,
          revisionNumber: (jev.revisionNumber ?? 0) + 1,
        };
        Object.assign(patch, { returnInfo: info, returnHistory: [...(jev.returnHistory ?? []), info], revisionNumber: info.revisionNumber });
      }
      tx.update(ref, patch);
      writeWorkflowHistory(tx, ctx, { barangayId: jev.barangayId, module: 'journalEntries', recordId: ref.id, fromStatus: jev.status, toStatus: t.to, remarks: input.remarks ?? null });
      audit.write({ module: 'journalEntries', recordId: ref.id, action: action === 'SUBMIT' ? 'SUBMIT' : action, oldValue: { status: jev.status }, newValue: { status: t.to }, reason: input.remarks ?? null, source: `callable:${action.toLowerCase()}JournalEntry` });
      audit.commit();
      return { status: t.to };
    });
  });
}

export const submitJournalEntry = jevTransition('SUBMIT');
export const approveJournalEntry = jevTransition('APPROVE');
export const returnJournalEntry = jevTransition('RETURN');
