import {
  BfmsError,
  COL,
  assertIsoDate,
  assertPeriodAllowsPosting,
  assertSegregation,
  balanceDeltas,
  findTransition,
  JEV_SOURCES,
  JEV_TRANSITIONS,
  periodDocId,
  periodOfDate,
  reverseLines,
  validateJournalAccounts,
  validateJournalBalance,
  type ChartOfAccountDoc,
  type JournalEntryDoc,
  type JournalLineDoc,
  type PeriodStatus,
  type SourceModule,
  type SubsidiaryAccountDoc,
} from '@bfms/shared';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../audit/auditWriter';
import { db, FieldValue, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';
import type { CallerContext } from '../lib/context';
import { SequenceAllocator } from '../numbering/sequences';

interface Loaded {
  accounts: Map<string, ChartOfAccountDoc>;
  subsidiaries: Map<string, SubsidiaryAccountDoc>;
}

/** READ phase helper: fetch every COA and SL document referenced by the lines. */
async function loadMasters(tx: Transaction, lines: JournalLineDoc[]): Promise<Loaded> {
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const sls = [...new Set(lines.map((l) => l.subsidiaryId).filter((s): s is string => !!s))];
  const [acctSnaps, slSnaps] = await Promise.all([
    codes.length ? tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c))) : Promise.resolve([]),
    sls.length ? tx.getAll(...sls.map((s) => db.collection(COL.subsidiaryAccounts).doc(s))) : Promise.resolve([]),
  ]);
  return {
    accounts: new Map(acctSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as ChartOfAccountDoc])),
    subsidiaries: new Map(slSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as SubsidiaryAccountDoc])),
  };
}

/** WRITE phase helper: atomic increments on period balance aggregates (no read needed). */
function writeBalances(tx: Transaction, jev: Pick<JournalEntryDoc, 'barangayId' | 'fiscalYear' | 'fundId' | 'accountingPeriod'>, lines: Pick<JournalLineDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit'>[]) {
  const month = Number(jev.accountingPeriod.slice(5, 7));
  const now = Timestamp.now();
  for (const d of balanceDeltas(jev.barangayId, jev.fiscalYear, month, jev.fundId, lines)) {
    tx.set(
      db.collection(COL.accountBalances).doc(d.id),
      {
        barangayId: jev.barangayId,
        fiscalYear: jev.fiscalYear,
        month,
        accountingPeriod: jev.accountingPeriod,
        fundId: jev.fundId,
        accountCode: d.accountCode,
        subsidiaryId: d.subsidiaryId,
        debit: FieldValue.increment(d.debit),
        credit: FieldValue.increment(d.credit),
        lineCount: FieldValue.increment(d.lineCount),
        updatedAt: now,
      },
      { merge: true },
    );
  }
}

/**
 * postJournalEntry — the Accounting Posting Engine (Section XLIV; docs 04 §9).
 * Steps are numbered as in the master prompt.
 */
export async function postJournalEntryTx(jevId: string, ctx: CallerContext) {
  const ref = db.collection(COL.journalEntries).doc(jevId);
  return db.runTransaction(async (tx) => {
    // 5. Retrieve JEV
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Journal entry not found.');
    const jev = snap.data() as JournalEntryDoc;
    // 2–3. Permission at this barangay (also verifies barangay access) — before revealing anything
    ctx.require('jev.post', jev.barangayId);
    // 13. Prevent duplicate posting (idempotent retry returns the existing number)
    if (jev.status === 'POSTED' || jev.postedAt) return { jevNumber: jev.jevNumber, alreadyPosted: true };
    // 6. Verify status (APPROVED → POSTED)
    findTransition(JEV_TRANSITIONS, 'POST', jev.status);
    const settings = await tx.get(db.collection(COL.systemSettings).doc('global'));
    assertSegregation(jev.createdBy, ctx.uid, 'post', settings.get('allowSelfPost') === true);
    // 4. Verify accounting period
    const month = Number(jev.accountingPeriod.slice(5, 7));
    const period = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(jev.barangayId, jev.fiscalYear, month)));
    assertPeriodAllowsPosting(period.get('status') as PeriodStatus | undefined, jev.entryType);
    // 7. Retrieve journal lines
    const lineSnap = await tx.get(ref.collection(COL.lines).orderBy('lineNo'));
    const lines = lineSnap.docs.map((d) => d.data() as JournalLineDoc);
    if (lines.length !== jev.lineCount)
      throw new BfmsError('VALIDATION_FAILED', `Line count mismatch (header ${jev.lineCount}, found ${lines.length}).`);
    if (lines.some((l) => l.barangayId !== jev.barangayId || l.jevId !== jevId))
      throw new BfmsError('BARANGAY_MISMATCH', 'A journal line does not belong to this entry/barangay.');
    // 8–9. Validate accounts and subsidiary requirements
    const { accounts, subsidiaries } = await loadMasters(tx, lines);
    validateJournalAccounts(lines, jev.barangayId, accounts, subsidiaries);
    // 10–12. Debit = Credit
    const totals = validateJournalBalance(lines);
    // Source document (read before writes)
    const source = JEV_SOURCES[jev.sourceModule];
    let srcRef: DocumentReference | null = null;
    if (source && jev.sourceDocumentId) {
      srcRef = db.collection(source.collection).doc(jev.sourceDocumentId);
      const src = await tx.get(srcRef);
      if (!src.exists) throw new BfmsError('VALIDATION_FAILED', 'Source document not found.');
      if (src.get('barangayId') !== jev.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'Source document belongs to another barangay.');
      const srcJev = src.get('jevId') as string | null | undefined;
      if (srcJev && srcJev !== jevId) throw new BfmsError('ALREADY_POSTED', 'The source document is already linked to another journal entry.', { jevId: srcJev });
      if (source.workflow && !['ACCEPTED', 'APPROVED'].includes(src.get('status') as string))
        throw new BfmsError('INVALID_STATUS', `The source document is ${String(src.get('status'))}; only ACCEPTED/APPROVED documents can be posted.`);
    }
    const seq = await SequenceAllocator.read(tx, jev.barangayId, jev.fiscalYear, 'JEV');
    const audit = await AuditWriter.begin(tx, ctx, jev.barangayId);

    // ---- WRITE PHASE ----
    const now = Timestamp.now();
    const jevNumber = seq.allocate(month === 0 ? 1 : Math.min(month, 12), COL.journalEntries, jevId);
    seq.commit();
    // 14–15. Post & freeze
    tx.update(ref, {
      status: 'POSTED',
      jevNumber,
      totalDebit: totals.totalDebit,
      totalCredit: totals.totalCredit,
      postedBy: ctx.uid,
      postedAt: now,
      updatedAt: now,
      updatedBy: ctx.uid,
    });
    lineSnap.docs.forEach((d) => tx.update(d.ref, { posted: true, jevNumber }));
    // 16. Update summaries (period balance aggregates)
    writeBalances(tx, jev, lines);
    if (srcRef)
      tx.update(srcRef, source?.workflow ? { jevId, jevNumber, status: 'POSTED', postedBy: ctx.uid, postedAt: now } : { jevId, jevNumber, postedAt: now });
    // 17. Audit + workflow history
    writeWorkflowHistory(tx, ctx, { barangayId: jev.barangayId, module: 'journalEntries', recordId: jevId, fromStatus: jev.status, toStatus: 'POSTED' });
    audit.write({
      module: 'journalEntries',
      recordId: jevId,
      action: 'POST',
      oldValue: { status: jev.status },
      newValue: { status: 'POSTED', jevNumber, totalDebit: totals.totalDebit, totalCredit: totals.totalCredit },
      source: 'callable:postJournalEntry',
    });
    audit.commit();
    return { jevNumber, alreadyPosted: false };
  });
}

export const postJournalEntry = secureCallable(z.object({ jevId: z.string().min(1) }), async ({ jevId }, ctx) =>
  postJournalEntryTx(jevId, ctx),
);

/**
 * reverseJournalEntry — never edits the original lines. Creates and posts a REVERSING JEV dated
 * `reversalDate` (must fall in an OPEN/REVIEW period), links both entries, marks original REVERSED.
 */
export const reverseJournalEntry = secureCallable(
  z.object({ jevId: z.string().min(1), reversalDate: z.string(), reason: z.string().min(10).max(1000) }),
  async (input, ctx) => {
    const origRef = db.collection(COL.journalEntries).doc(input.jevId);
    const revRef = db.collection(COL.journalEntries).doc();
    const date = assertIsoDate(input.reversalDate, 'reversalDate');
    const { fiscalYear, month, key } = periodOfDate(date);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(origRef);
      if (!snap.exists) throw new HttpsError('not-found', 'Journal entry not found.');
      const orig = snap.data() as JournalEntryDoc;
      ctx.require('jev.reverse', orig.barangayId);
      findTransition(JEV_TRANSITIONS, 'REVERSE', orig.status);
      if (orig.reversedByJevId) throw new BfmsError('ALREADY_POSTED', 'This entry has already been reversed.');
      if (fiscalYear !== orig.fiscalYear)
        throw new BfmsError('PERIOD_MISMATCH', 'Reversal must be dated within the same fiscal year; use a prior-year adjustment otherwise.');
      const period = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(orig.barangayId, fiscalYear, month)));
      assertPeriodAllowsPosting(period.get('status') as PeriodStatus | undefined, 'REVERSING');
      const origLines = (await tx.get(origRef.collection(COL.lines).orderBy('lineNo'))).docs.map((d) => d.data() as JournalLineDoc);
      const revLines = reverseLines(origLines);
      const totals = validateJournalBalance(revLines);
      const seq = await SequenceAllocator.read(tx, orig.barangayId, fiscalYear, 'JEV');
      const audit = await AuditWriter.begin(tx, ctx, orig.barangayId);

      const now = Timestamp.now();
      const jevNumber = seq.allocate(month, COL.journalEntries, revRef.id);
      seq.commit();
      const rev: Omit<JournalEntryDoc, 'submittedBy'> = {
        barangayId: orig.barangayId,
        fiscalYear,
        accountingPeriod: key,
        jevNumber,
        jevDate: date,
        fundId: orig.fundId,
        journal: orig.journal,
        entryType: 'REVERSING',
        sourceModule: orig.sourceModule,
        sourceDocumentId: orig.sourceDocumentId,
        primaryReference: orig.primaryReference,
        secondaryReference: orig.jevNumber,
        tertiaryReference: null,
        particulars: `Reversal of JEV ${orig.jevNumber}: ${input.reason}`,
        totalDebit: totals.totalDebit,
        totalCredit: totals.totalCredit,
        lineCount: revLines.length,
        reversesJevId: input.jevId,
        reversedByJevId: null,
        status: 'POSTED',
        revisionNumber: 0,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
        approvedBy: ctx.uid,
        approvedAt: now,
        postedBy: ctx.uid,
        postedAt: now,
      };
      tx.create(revRef, rev);
      revLines.forEach((l, i) => {
        const o = origLines[i]!;
        tx.create(revRef.collection(COL.lines).doc(String(i + 1).padStart(3, '0')), {
          ...o,
          accountingPeriod: key,
          fiscalYear,
          jevId: revRef.id,
          jevDate: date,
          jevNumber,
          entryType: 'REVERSING',
          posted: true,
          debit: l.debit,
          credit: l.credit,
          lineDescription: l.lineDescription ?? '',
        } satisfies JournalLineDoc);
      });
      writeBalances(tx, { barangayId: orig.barangayId, fiscalYear, fundId: orig.fundId, accountingPeriod: key }, revLines.map((l) => ({ accountCode: l.accountCode, subsidiaryId: l.subsidiaryId ?? null, debit: l.debit, credit: l.credit })));
      tx.update(origRef, { status: 'REVERSED', reversedByJevId: revRef.id, updatedAt: now, updatedBy: ctx.uid });
      writeWorkflowHistory(tx, ctx, { barangayId: orig.barangayId, module: 'journalEntries', recordId: input.jevId, fromStatus: 'POSTED', toStatus: 'REVERSED', remarks: input.reason });
      audit.write({ module: 'journalEntries', recordId: input.jevId, action: 'REVERSE', oldValue: { status: 'POSTED' }, newValue: { status: 'REVERSED', reversedByJevId: revRef.id, reversalJevNumber: jevNumber }, reason: input.reason, source: 'callable:reverseJournalEntry' });
      audit.commit();
      return { reversalJevId: revRef.id, jevNumber };
    });
  },
);
