import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  LINE_CLASSES,
  MAX_STATEMENT_LINES,
  SIGNED_CATEGORIES,
  assertReconciliationBalanced,
  bankPeriodDocId,
  buildStatementLines,
  defaultMemoAccount,
  lastDayOfMonth,
  periodDocId,
  periodKey,
  type BankReconciliationRecord,
  type BarangayId,
  type Centavos,
  type LineClass,
  type MemoCategory,
  type ReconItemCategory,
} from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';
import type { CallerContext } from '../../lib/context';
import { SequenceAllocator } from '../../numbering/sequences';
import { createGeneratedJev } from '../../sources/jev';
import { computeRecon, loadRecon, memoJevLines, reconFigures, storedInputs, writeItems, type ReconInputs } from './recon';

const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signed = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const period = z.object({ barangayId: barangay, bankAccountId: z.string().min(1).max(128), fiscalYear: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
const CATEGORIES = ['DEPOSIT_IN_TRANSIT', 'OUTSTANDING_CHECK', 'BANK_DEBIT_MEMO', 'BANK_CREDIT_MEMO', 'BANK_CHARGES', 'INTEREST_INCOME', 'BOOK_ERROR', 'BANK_ERROR', 'OTHER_BOOK', 'OTHER_BANK'] as const;
const lineClass = z.enum(LINE_CLASSES.map((c) => c.value) as [LineClass, ...LineClass[]]);

function inMonth(date: string, fiscalYear: number, month: number) {
  return date.startsWith(periodKey(fiscalYear, month));
}

// ------------------------------------------------------------------ statements

/**
 * Save the bank statement of one bank account for one month (`bankStatements/{bid}_{bank}_{fy}_{mm}`).
 * Lines are fully replaced; the server recomputes running balances and checks that
 * beginning + credits − debits = ending (an unbalanced statement can be saved but not reconciled).
 */
export const saveBankStatement = secureCallable(
  period.extend({
    statementDate: isoDate.nullish(),
    beginningBalance: signed,
    endingBalance: signed,
    source: z.enum(['MANUAL', 'IMPORT']).default('MANUAL'),
    attachmentId: z.string().max(128).nullish(),
    lines: z
      .array(
        z.object({
          lineId: z.string().max(40).regex(/^[A-Za-z0-9-]+$/).nullish(),
          date: isoDate,
          reference: z.string().trim().max(60).default(''),
          description: z.string().trim().max(200).default(''),
          debit: centavos,
          credit: centavos,
        }),
      )
      .max(MAX_STATEMENT_LINES),
  }),
  async (input, ctx) => {
    ctx.require('recon.prepare', input.barangayId);
    const bad = input.lines.findIndex((l) => !inMonth(l.date, input.fiscalYear, input.month) || (l.debit > 0) === (l.credit > 0));
    if (bad >= 0) {
      const l = input.lines[bad]!;
      throw new BfmsError('VALIDATION_FAILED', `Line ${bad + 1}: ${!inMonth(l.date, input.fiscalYear, input.month) ? `date ${l.date} is outside ${periodKey(input.fiscalYear, input.month)}` : 'enter either a debit or a credit amount'}.`);
    }
    const monthEnd = lastDayOfMonth(input.fiscalYear, input.month);
    const statementDate = input.statementDate ?? monthEnd;
    if (!inMonth(statementDate, input.fiscalYear, input.month)) throw new BfmsError('VALIDATION_FAILED', 'The statement date must fall in the statement month.');
    const id = bankPeriodDocId(input.barangayId, input.bankAccountId, input.fiscalYear, input.month);
    const ref = db.collection(COL.bankStatements).doc(id);
    const built = buildStatementLines(input.beginningBalance as Centavos, input.lines.map((l) => ({ ...l, date: l.date, debit: l.debit as Centavos, credit: l.credit as Centavos })));
    await db.runTransaction(async (tx) => {
      const [bank, snap, recon] = await Promise.all([tx.get(db.collection(COL.bankAccounts).doc(input.bankAccountId)), tx.get(ref), tx.get(db.collection(COL.bankReconciliations).doc(id))]);
      if (!bank.exists || bank.get('barangayId') !== input.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'Bank account not found for this barangay.');
      if (recon.get('status') === 'FINAL' || recon.get('status') === 'FOR_REVIEW')
        throw new BfmsError('INVALID_STATUS', `The reconciliation for this month is ${String(recon.get('status'))}; the statement can no longer be changed.`);
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const body = {
        barangayId: input.barangayId,
        fiscalYear: input.fiscalYear,
        month: input.month,
        bankAccountId: input.bankAccountId,
        statementPeriod: periodKey(input.fiscalYear, input.month),
        statementDate,
        beginningBalance: input.beginningBalance,
        endingBalance: input.endingBalance,
        attachmentId: input.attachmentId ?? null,
        source: input.source,
        lines: built.lines,
        lineCount: built.lines.length,
        totalDebits: built.totalDebits,
        totalCredits: built.totalCredits,
        computedEndingBalance: built.computedEndingBalance,
        balanced: built.computedEndingBalance === input.endingBalance,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      tx.set(ref, snap.exists ? body : { ...body, createdAt: now, createdBy: ctx.uid }, { merge: true });
      const summary = { beginningBalance: body.beginningBalance, endingBalance: body.endingBalance, lineCount: body.lineCount, totalDebits: body.totalDebits, totalCredits: body.totalCredits, balanced: body.balanced };
      audit.write({ module: COL.bankStatements, recordId: id, action: snap.exists ? 'EDIT' : 'CREATE', oldValue: snap.exists ? { endingBalance: snap.get('endingBalance'), lineCount: snap.get('lineCount') } : null, newValue: summary, source: 'callable:saveBankStatement' });
      audit.commit();
    });
    return { id, balanced: built.computedEndingBalance === input.endingBalance, computedEndingBalance: built.computedEndingBalance, lineIds: built.lines.map((l) => l.lineId) };
  },
);

// ------------------------------------------------------------------ reconciliation

const manualItem = z
  .object({
    id: z.string().min(1).max(40),
    category: z.enum(CATEGORIES),
    date: isoDate,
    reference: z.string().trim().max(60).default(''),
    name: z.string().trim().min(2).max(200),
    amount: signed,
    remarks: z.string().trim().max(500).default(''),
  })
  .refine((m) => m.amount !== 0, 'Amount must not be zero.')
  .refine((m) => (SIGNED_CATEGORIES as readonly string[]).includes(m.category) || m.amount > 0, 'Only errors and "other" items may be negative.');

/**
 * Prepare (or re-prepare) the reconciliation: book balance from the GL, bank balance from the
 * statement, auto-matching, reconciling items. Classifications, manual items and manual matches
 * sent here replace the stored ones (omit them to keep what is stored).
 */
export const prepareBankReconciliation = secureCallable(
  period.extend({
    classifications: z.record(z.string().max(40), lineClass).refine((r) => Object.keys(r).length <= MAX_STATEMENT_LINES, 'Too many classifications.').optional(),
    manualItems: z.array(manualItem).max(200).optional(),
    manualMatches: z.array(z.object({ lineId: z.string().max(40), sourceCollection: z.enum(['checks', 'deposits', 'adas', 'bankMemos']), sourceId: z.string().max(128) })).max(500).optional(),
    remarks: z.string().max(1000).optional(),
  }),
  async (input, ctx) => {
    ctx.require('recon.prepare', input.barangayId);
    return db.runTransaction(async (tx) => {
      const l = await loadRecon(tx, input);
      const status = (l.recon.get('status') as string | undefined) ?? 'DRAFT';
      if (!['DRAFT', 'RETURNED'].includes(status)) throw new BfmsError('INVALID_STATUS', `A ${status} reconciliation cannot be re-prepared.`);
      const stored = storedInputs(l.recon);
      const inputs: ReconInputs = {
        classifications: input.classifications ?? stored.classifications,
        manualItems: input.manualItems ?? stored.manualItems,
        manualMatches: input.manualMatches ?? stored.manualMatches,
      };
      const r = computeRecon(l, inputs);
      // A person's new match that cannot apply is an error; stale stored ones are simply dropped.
      if (input.manualMatches && r.rejectedMatches.length)
        throw new BfmsError('VALIDATION_FAILED', `Match not possible: ${r.rejectedMatches.map((m) => m.reason).join('; ')}.`, { rejected: r.rejectedMatches });
      inputs.manualMatches = inputs.manualMatches.filter((m) => !r.rejectedMatches.some((x) => x.lineId === m.lineId && x.sourceId === m.sourceId));
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const ref = db.collection(COL.bankReconciliations).doc(l.id);
      writeItems(tx, l, r);
      const figures = reconFigures(l, r);
      const header = {
        barangayId: input.barangayId,
        fiscalYear: input.fiscalYear,
        month: input.month,
        bankAccountId: input.bankAccountId,
        statementId: l.id,
        bankName: l.bank.bankName,
        accountNumber: l.bank.accountNumber,
        subsidiaryId: l.bank.subsidiaryId,
        ...figures,
        ...inputs,
        status,
        remarks: input.remarks ?? (l.recon.get('remarks') as string | undefined) ?? '',
        preparedBy: ctx.uid,
        preparedAt: now,
        updatedAt: now,
        updatedBy: ctx.uid,
      };
      if (l.recon.exists) tx.update(ref, header);
      else tx.create(ref, { ...header, finalizedBy: null, finalizedAt: null, revisionNumber: 0, createdAt: now, createdBy: ctx.uid });
      audit.write({
        module: COL.bankReconciliations,
        recordId: l.id,
        action: l.recon.exists ? 'EDIT' : 'CREATE',
        oldValue: l.recon.exists ? { difference: l.recon.get('difference'), adjustedBookBalance: l.recon.get('adjustedBookBalance') } : null,
        newValue: { bookBalance: figures.bookBalance, bankBalance: figures.bankBalance, adjustedBookBalance: r.adjustedBookBalance, adjustedBankBalance: r.adjustedBankBalance, difference: r.difference, items: r.items.length, matches: r.matches.length },
        source: 'callable:prepareBankReconciliation',
      });
      audit.commit();
      return { id: l.id, bookBalance: figures.bookBalance, bankBalance: figures.bankBalance, adjustedBookBalance: r.adjustedBookBalance, adjustedBankBalance: r.adjustedBankBalance, difference: r.difference, matches: r.matches.length, items: r.items.length, unmatchedLines: figures.unmatchedLineCount };
    });
  },
);

const idInput = z.object({ id: z.string().min(1).max(200), remarks: z.string().max(1000).optional() });

async function reconTransition(
  id: string,
  ctx: CallerContext,
  spec: { from: readonly string[]; to: string; permission: 'recon.prepare' | 'recon.finalize'; audit: 'SUBMIT' | 'RETURN' | 'FINALIZE_REPORT'; remarks?: string },
  extra?: (r: BankReconciliationRecord, tx: FirebaseFirestore.Transaction) => Promise<(now: FirebaseFirestore.Timestamp, audit: AuditWriter) => Record<string, unknown>>,
) {
  const ref = db.collection(COL.bankReconciliations).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Bank reconciliation not found. Prepare it first.');
    const r = snap.data() as BankReconciliationRecord;
    ctx.require(spec.permission, r.barangayId);
    if (!spec.from.includes(r.status)) throw new BfmsError('INVALID_STATUS', `This action is not allowed while the reconciliation is ${r.status}.`);
    const writer = extra ? await extra(r, tx) : null;
    const audit = await AuditWriter.begin(tx, ctx, r.barangayId);
    const now = Timestamp.now();
    const patch: Record<string, unknown> = { status: spec.to, updatedAt: now, updatedBy: ctx.uid, ...(writer ? writer(now, audit) : {}) };
    tx.update(ref, patch);
    writeWorkflowHistory(tx, ctx, { barangayId: r.barangayId, module: COL.bankReconciliations, recordId: id, fromStatus: r.status, toStatus: spec.to, remarks: spec.remarks ?? null });
    audit.write({ module: COL.bankReconciliations, recordId: id, action: spec.audit, oldValue: { status: r.status }, newValue: { status: spec.to, difference: (patch.difference as number | undefined) ?? r.difference }, reason: spec.remarks ?? null, source: `callable:bankReconciliation:${spec.audit}` });
    audit.commit();
    return { status: spec.to };
  });
}

/** DRAFT/RETURNED → FOR_REVIEW (the preparer hands it to the Municipal Accountant). */
export const submitBankReconciliation = secureCallable(idInput, async (input, ctx) =>
  reconTransition(input.id, ctx, { from: ['DRAFT', 'RETURNED'], to: 'FOR_REVIEW', permission: 'recon.prepare', audit: 'SUBMIT', remarks: input.remarks }, async (r, tx) => {
    const stmt = await tx.get(db.collection(COL.bankStatements).doc(r.statementId));
    if (stmt.get('balanced') !== true) throw new BfmsError('VALIDATION_FAILED', 'The bank statement lines do not add up to its ending balance.');
    return (now) => ({ submittedBy: ctx.uid, submittedAt: now });
  }),
);

/** FOR_REVIEW → RETURNED with the reviewer's reason. */
export const returnBankReconciliation = secureCallable(idInput, async (input, ctx) => {
  if (!input.remarks || input.remarks.trim().length < 5) throw new HttpsError('invalid-argument', 'Please state the reason (at least 5 characters).');
  return reconTransition(input.id, ctx, { from: ['FOR_REVIEW'], to: 'RETURNED', permission: 'recon.finalize', audit: 'RETURN', remarks: input.remarks.trim() }, async (r) => (now) => {
    const info = { reasonForReturn: input.remarks!.trim(), requiredCorrection: input.remarks!.trim(), returnedBy: ctx.uid, returnedAt: now, assignedTo: r.preparedBy, revisionNumber: (r.revisionNumber ?? 0) + 1 };
    return { returnInfo: info, returnHistory: [...(r.returnHistory ?? []), info], revisionNumber: info.revisionNumber };
  });
});

/**
 * FOR_REVIEW → FINAL (Municipal Accountant). Recomputes everything from current data, requires a
 * balanced statement and difference = 0, then marks matched checks CLEARED (statement date) and
 * matched deposits/ADAs as reconciled. FINAL reconciliations feed the period lock checklist.
 */
export const finalizeBankReconciliation = secureCallable(idInput, async (input, ctx) =>
  reconTransition(input.id, ctx, { from: ['FOR_REVIEW'], to: 'FINAL', permission: 'recon.finalize', audit: 'FINALIZE_REPORT', remarks: input.remarks }, async (rec, tx) => {
    const l = await loadRecon(tx, { barangayId: rec.barangayId, bankAccountId: rec.bankAccountId, fiscalYear: rec.fiscalYear, month: rec.month });
    if (!l.statement?.balanced) throw new BfmsError('VALIDATION_FAILED', 'The bank statement lines do not add up to its ending balance.');
    const r = computeRecon(l, storedInputs(l.recon));
    assertReconciliationBalanced(r.difference);
    const checkById = new Map(l.checks.map((c) => [c.id, c]));
    const adaById = new Map(l.adas.map((a) => [a.id, a]));
    return (now, audit) => {
      writeItems(tx, l, r);
      for (const m of r.matches) {
        if (m.sourceCollection === 'checks') {
          const c = checkById.get(m.sourceId)!;
          if (c.status === 'CLEARED' && c.clearedDate === m.date) continue;
          tx.update(db.collection(COL.checks).doc(m.sourceId), { status: 'CLEARED', clearedDate: m.date, bankReconciliationId: l.id, updatedAt: now, updatedBy: ctx.uid });
          audit.write({ module: COL.checks, recordId: m.sourceId, action: 'CLEAR', oldValue: { status: c.status, clearedDate: c.clearedDate }, newValue: { status: 'CLEARED', clearedDate: m.date }, source: 'callable:finalizeBankReconciliation' });
        } else if (m.sourceCollection === 'deposits') {
          tx.update(db.collection(COL.deposits).doc(m.sourceId), { bankReconciledDate: m.date, bankReconciliationId: l.id });
        } else if (m.sourceCollection === 'adas' && !adaById.get(m.sourceId)?.clearedDate) {
          tx.update(db.collection(COL.adas).doc(m.sourceId), { clearedDate: m.date, bankReconciliationId: l.id });
        }
      }
      return { ...reconFigures(l, r), finalizedBy: ctx.uid, finalizedAt: now };
    };
  }),
);

// ------------------------------------------------------------------ RBDCM entries

const MEMO_LINE_CATEGORIES: Partial<Record<ReconItemCategory, { memoType: 'DEBIT' | 'CREDIT'; category: MemoCategory }>> = {
  BANK_CHARGES: { memoType: 'DEBIT', category: 'BANK_CHARGES' },
  BANK_DEBIT_MEMO: { memoType: 'DEBIT', category: 'OTHER' },
  INTEREST_INCOME: { memoType: 'CREDIT', category: 'INTEREST_INCOME' },
  BANK_CREDIT_MEMO: { memoType: 'CREDIT', category: 'OTHER' },
};

/**
 * Record the unrecorded memos of a reconciliation (docs 04 `generateRbdcmEntries`): one bank memo per
 * classified, still-unrecorded statement line. Memos with a known classification account (bank
 * charges, interest) get their BM number and a DRAFT JCT JEV at once; the others stay DRAFT until
 * accounting sets the account and runs "Generate JEV". Re-prepare the reconciliation afterwards.
 */
export const generateRbdcmEntries = secureCallable(period, async (input, ctx) => {
  ctx.require('jev.prepare', input.barangayId);
  return db.runTransaction(async (tx) => {
    const l = await loadRecon(tx, input);
    const status = (l.recon.get('status') as string | undefined) ?? 'DRAFT';
    if (!['DRAFT', 'RETURNED'].includes(status)) throw new BfmsError('INVALID_STATUS', `The reconciliation is ${status}.`);
    const r = computeRecon(l, storedInputs(l.recon));
    const todo = r.items.filter((i) => i.statementLineId && !i.sourceId && MEMO_LINE_CATEGORIES[i.category]);
    if (!todo.length) return { created: 0, jevs: 0, memoIds: [] as string[] };
    const codes = [...new Set(todo.map((i) => defaultMemoAccount(MEMO_LINE_CATEGORIES[i.category]!.memoType, MEMO_LINE_CATEGORIES[i.category]!.category)).filter((x): x is string => !!x))];
    const accts = codes.length ? await tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c))) : [];
    const activeCodes = new Set(accts.filter((a) => a.exists && a.get('active') !== false).map((a) => a.id));
    const [periodSnap, seq] = await Promise.all([
      tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(input.barangayId, input.fiscalYear, input.month))),
      SequenceAllocator.read(tx, input.barangayId, input.fiscalYear, 'MEMO'),
    ]);
    if (['LOCKED', 'CLOSED'].includes(periodSnap.get('status') as string)) throw new BfmsError('PERIOD_NOT_OPEN', `${periodKey(input.fiscalYear, input.month)} is ${String(periodSnap.get('status'))}.`);
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const memoIds: string[] = [];
    let jevs = 0;
    for (const i of todo) {
      const kind = MEMO_LINE_CATEGORIES[i.category]!;
      const acct = defaultMemoAccount(kind.memoType, kind.category);
      const ready = !!acct && activeCodes.has(acct);
      const ref = db.collection(COL.bankMemos).doc();
      const number = ready ? seq.allocate(input.month, COL.bankMemos, ref.id) : null;
      const particulars = (i.name || (kind.memoType === 'DEBIT' ? 'Bank debit memo' : 'Bank credit memo')).slice(0, 500);
      const jevId = ready
        ? createGeneratedJev(tx, ctx, { barangayId: input.barangayId, sourceModule: 'BANK_MEMO', sourceDocumentId: ref.id }, {
            jevDate: i.date,
            fundId: l.bank.fundId,
            journal: 'JCT',
            particulars: `Bank ${kind.memoType === 'DEBIT' ? 'debit' : 'credit'} memo ${number}: ${particulars}`,
            primaryReference: number,
            secondaryReference: i.reference || null,
            lines: memoJevLines(kind.memoType, i.amount, acct!, l.bank.subsidiaryId, particulars),
          })
        : null;
      if (jevId) jevs++;
      tx.create(ref, {
        barangayId: input.barangayId,
        fiscalYear: input.fiscalYear,
        accountingPeriod: periodKey(input.fiscalYear, input.month),
        bankAccountId: input.bankAccountId,
        memoType: kind.memoType,
        category: kind.category,
        memoDate: i.date,
        memoNumber: number,
        bankReference: i.reference,
        particulars,
        amount: i.amount,
        classificationAccountCode: acct,
        statementId: l.id,
        statementLineId: i.statementLineId,
        status: jevId ? 'ACCEPTED' : 'DRAFT',
        jevId,
        revisionNumber: 0,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
        ...(jevId ? { acceptedBy: ctx.uid, acceptedAt: now } : {}),
      });
      writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: COL.bankMemos, recordId: ref.id, fromStatus: null, toStatus: jevId ? 'ACCEPTED' : 'DRAFT', remarks: 'From bank reconciliation' });
      audit.write({ module: COL.bankMemos, recordId: ref.id, action: jevId ? 'GENERATE' : 'CREATE', newValue: { memoType: kind.memoType, amount: i.amount, memoNumber: number, jevId, statementLineId: i.statementLineId }, source: 'callable:generateRbdcmEntries' });
      memoIds.push(ref.id);
    }
    seq.commit();
    audit.commit();
    return { created: memoIds.length, jevs, memoIds };
  });
});
