import {
  BfmsError,
  CASH_IN_BANK,
  COL,
  OPEN_CHECK_STATUSES,
  bankPeriodDocId,
  bookBalanceFromRows,
  buildReconciliation,
  lastDayOfMonth,
  periodKey,
  toReconAda,
  toReconCheck,
  toReconDeposit,
  toReconMemo,
  type AccountBalanceDoc,
  type BankAccountDoc,
  type BankMemoRecord,
  type BankReconciliationRecord,
  type BankStatementRecord,
  type BarangayId,
  type Centavos,
  type CheckDoc,
  type DepositDoc,
  type LineClass,
  type ManualMatch,
  type ManualReconItem,
  type ReconAda,
  type ReconCheck,
  type ReconDeposit,
  type ReconMemo,
  type ReconResult,
} from '@bfms/shared';
import type { DocumentSnapshot, QuerySnapshot, Transaction } from 'firebase-admin/firestore';
import { db } from '../../lib/admin';

export interface ReconPeriod {
  barangayId: BarangayId;
  bankAccountId: string;
  fiscalYear: number;
  month: number;
}

export interface LoadedRecon {
  id: string;
  monthStart: string;
  monthEnd: string;
  bank: BankAccountDoc;
  statement: BankStatementRecord | null;
  recon: DocumentSnapshot;
  items: QuerySnapshot;
  bookBalance: Centavos;
  checks: ReconCheck[];
  deposits: ReconDeposit[];
  adas: ReconAda[];
  memos: ReconMemo[];
}

/**
 * READ phase: everything a reconciliation needs, inside the caller's transaction.
 * Queries use equality / `in` filters only (no composite indexes); periods are filtered in memory.
 */
export async function loadRecon(tx: Transaction, p: ReconPeriod): Promise<LoadedRecon> {
  const bankSnap = await tx.get(db.collection(COL.bankAccounts).doc(p.bankAccountId));
  if (!bankSnap.exists) throw new BfmsError('VALIDATION_FAILED', 'Bank account not found.');
  const bank = bankSnap.data() as BankAccountDoc;
  if (bank.barangayId !== p.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The bank account belongs to another barangay.');
  const id = bankPeriodDocId(p.barangayId, p.bankAccountId, p.fiscalYear, p.month);
  const ref = db.collection(COL.bankReconciliations).doc(id);
  const byBank = (col: string) => db.collection(col).where('barangayId', '==', p.barangayId).where('bankAccountId', '==', p.bankAccountId);
  const years = [p.fiscalYear - 1, p.fiscalYear];
  const [stmt, recon, items, openChecks, clearedChecks, deposits, adas, memos, balances] = await Promise.all([
    tx.get(db.collection(COL.bankStatements).doc(id)),
    tx.get(ref),
    tx.get(ref.collection('items')),
    tx.get(byBank(COL.checks).where('status', 'in', [...OPEN_CHECK_STATUSES])),
    tx.get(byBank(COL.checks).where('status', '==', 'CLEARED').where('fiscalYear', 'in', years)),
    tx.get(byBank(COL.deposits).where('fiscalYear', 'in', years)),
    tx.get(byBank(COL.adas).where('fiscalYear', 'in', years)),
    tx.get(byBank(COL.bankMemos).where('accountingPeriod', '==', periodKey(p.fiscalYear, p.month))),
    tx.get(
      db
        .collection(COL.accountBalances)
        .where('barangayId', '==', p.barangayId)
        .where('fiscalYear', '==', p.fiscalYear)
        .where('accountCode', '==', CASH_IN_BANK)
        .where('subsidiaryId', '==', bank.subsidiaryId),
    ),
  ]);
  return {
    id,
    monthStart: `${p.fiscalYear}-${String(p.month).padStart(2, '0')}-01`,
    monthEnd: lastDayOfMonth(p.fiscalYear, p.month),
    bank,
    statement: stmt.exists ? (stmt.data() as BankStatementRecord) : null,
    recon,
    items,
    bookBalance: bookBalanceFromRows(balances.docs.map((d) => d.data() as AccountBalanceDoc), CASH_IN_BANK, bank.subsidiaryId, p.month),
    checks: [...openChecks.docs, ...clearedChecks.docs].map((d) => toReconCheck(d.id, d.data() as CheckDoc)),
    deposits: deposits.docs.map((d) => toReconDeposit(d.id, d.data() as DepositDoc)),
    adas: adas.docs.flatMap((d) => toReconAda(d.id, d.data()) ?? []),
    memos: memos.docs.map((d) => toReconMemo(d.id, d.data() as BankMemoRecord)),
  };
}

export interface ReconInputs {
  classifications: Record<string, LineClass>;
  manualItems: ManualReconItem[];
  manualMatches: ManualMatch[];
}

export function storedInputs(recon: DocumentSnapshot): ReconInputs {
  const r = recon.data() as Partial<BankReconciliationRecord> | undefined;
  return { classifications: r?.classifications ?? {}, manualItems: r?.manualItems ?? [], manualMatches: r?.manualMatches ?? [] };
}

export function computeRecon(l: LoadedRecon, inputs: ReconInputs): ReconResult {
  if (!l.statement) throw new BfmsError('VALIDATION_FAILED', 'Enter the bank statement for this month first.');
  return buildReconciliation({
    monthStart: l.monthStart,
    monthEnd: l.monthEnd,
    bookBalance: l.bookBalance,
    bankBalance: l.statement.endingBalance,
    lines: l.statement.lines,
    checks: l.checks,
    deposits: l.deposits,
    adas: l.adas,
    memos: l.memos,
    ...inputs,
  });
}

/** Header fields of the reconciliation document derived from a computed result. */
export function reconFigures(l: LoadedRecon, r: ReconResult) {
  return {
    bookBalance: l.bookBalance,
    bankBalance: l.statement!.endingBalance,
    ...r.totals,
    adjustedBookBalance: r.adjustedBookBalance,
    adjustedBankBalance: r.adjustedBankBalance,
    difference: r.difference,
    matches: r.matches,
    itemCount: r.items.length,
    unmatchedLineCount: Object.keys(r.lineClasses).length,
    statementDate: l.statement!.statementDate,
    monthEnd: l.monthEnd,
  };
}

/** WRITE phase: replace the items subcollection with the freshly computed items. */
export function writeItems(tx: Transaction, l: LoadedRecon, r: ReconResult): void {
  const ref = db.collection(COL.bankReconciliations).doc(l.id);
  const keep = new Set(r.items.map((i) => String(i.seq).padStart(4, '0')));
  l.items.docs.forEach((d) => !keep.has(d.id) && tx.delete(d.ref));
  for (const i of r.items) tx.set(ref.collection('items').doc(String(i.seq).padStart(4, '0')), i);
}

/**
 * Lock checklist (docs 04 §19): every active bank account of the barangay must have a FINAL
 * reconciliation for the month. For lockAccountingPeriod (closing/periods.ts) to call in its READ phase.
 */
export async function assertBankReconciliationsFinal(tx: Transaction, barangayId: BarangayId, fiscalYear: number, month: number): Promise<void> {
  const banks = await tx.get(db.collection(COL.bankAccounts).where('barangayId', '==', barangayId).where('active', '==', true));
  if (banks.empty) return;
  const recons = await tx.getAll(...banks.docs.map((b) => db.collection(COL.bankReconciliations).doc(bankPeriodDocId(barangayId, b.id, fiscalYear, month))));
  const missing = banks.docs.filter((b, i) => recons[i]!.get('status') !== 'FINAL').map((b) => `${b.get('bankName') as string} ${String(b.get('accountNumber')).slice(-4)}`);
  if (missing.length)
    throw new BfmsError('RECONCILIATION_NOT_BALANCED', `The bank reconciliation for ${periodKey(fiscalYear, month)} is not FINAL for: ${missing.join(', ')}.`, { missing });
}

/** Dr expense / Cr Cash in Bank (debit memo) or Dr Cash in Bank / Cr income (credit memo). */
export function memoJevLines(memoType: 'DEBIT' | 'CREDIT', amount: number, accountCode: string, bankSl: string, description: string) {
  const bank = { accountCode: CASH_IN_BANK, subsidiaryId: bankSl, lineDescription: description };
  const other = { accountCode, subsidiaryId: null, lineDescription: description };
  return memoType === 'DEBIT'
    ? [{ ...other, debit: amount, credit: 0 }, { ...bank, debit: 0, credit: amount }]
    : [{ ...bank, debit: amount, credit: 0 }, { ...other, debit: 0, credit: amount }];
}
