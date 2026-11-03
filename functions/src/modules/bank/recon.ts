import {
  BfmsError,
  CASH_IN_BANK,
  COL,
  bankPeriodDocId,
  loadBankReconData,
  periodKey,
  runBankRecon,
  storedReconInputs,
  type BankReconData,
  type BankReconInputs,
  type BankReconPeriod,
  type BankReconRun,
  type BarangayId,
  type DataSource,
  type Filter,
  type OrderBy,
  type WithId,
} from '@bfms/shared';
import type { Query, Transaction } from 'firebase-admin/firestore';
import { db } from '../../lib/admin';

function apply(q: Query, filters: readonly Filter[], orderBy: readonly OrderBy[] = [], limit?: number): Query {
  let out = q;
  for (const [f, op, v] of filters) out = out.where(f, op, v);
  for (const [f, dir] of orderBy) out = out.orderBy(f, dir ?? 'asc');
  if (limit) out = out.limit(limit);
  return out;
}

/**
 * The report DataSource over a Firestore transaction: the shared loader then reads the journal,
 * statements and reconciliations consistently inside the callable's READ phase.
 */
export function txDataSource(tx: Transaction): DataSource {
  const docs = <T>(s: FirebaseFirestore.QuerySnapshot) => s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>);
  return {
    async get<T>(col: string, id: string) {
      const s = await tx.get(db.collection(col).doc(id));
      return s.exists ? ({ ...(s.data() as T), id: s.id } as WithId<T>) : null;
    },
    async list<T>(col: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number) {
      return docs<T>(await tx.get(apply(db.collection(col), filters, orderBy, limit)));
    },
    async listGroup<T>(sub: string, filters: readonly Filter[], orderBy?: readonly OrderBy[], limit?: number) {
      return docs<T>(await tx.get(apply(db.collectionGroup(sub), filters, orderBy, limit)));
    },
    async listSub<T>(col: string, id: string, sub: string, orderBy?: readonly OrderBy[]) {
      return docs<T>(await tx.get(apply(db.collection(col).doc(id).collection(sub), [], orderBy)));
    },
  };
}

export interface LoadedRecon extends BankReconData {
  /** Existing item documents of this month's reconciliation (replaced on every Prepare). */
  itemIds: string[];
}

/** READ phase: everything a reconciliation needs, inside the caller's transaction. */
export async function loadRecon(tx: Transaction, p: BankReconPeriod): Promise<LoadedRecon> {
  const ds = txDataSource(tx);
  let d: BankReconData;
  try {
    d = await loadBankReconData(ds, p);
  } catch (e) {
    throw new BfmsError('BARANGAY_MISMATCH', (e as Error).message);
  }
  const items = await tx.get(db.collection(COL.bankReconciliations).doc(d.id).collection('items'));
  return { ...d, itemIds: items.docs.map((x) => x.id) };
}

export function computeRecon(l: LoadedRecon, inputs: BankReconInputs = storedReconInputs(l)): BankReconRun {
  if (!l.statement) throw new BfmsError('VALIDATION_FAILED', 'Enter the bank statement for this month first.');
  return runBankRecon(l, inputs);
}

/** Header fields of the reconciliation document derived from a computed result. */
export function reconFigures(l: LoadedRecon, r: BankReconRun) {
  return {
    bookBalance: r.bookBalance,
    bankBalance: r.bankBalance,
    ...r.totals,
    adjustedBookBalance: r.adjustedBookBalance,
    adjustedBankBalance: r.adjustedBankBalance,
    difference: r.difference,
    matches: r.matches,
    itemCount: r.items.length,
    unmatchedLineCount: Object.keys(r.lineClasses).length,
    outstandingCheckCount: r.items.filter((i) => i.category === 'OUTSTANDING_CHECK').length,
    checksIssuedCount: r.schedule1.filter((s) => !s.priorYear && !s.key.startsWith('LINE:')).length,
    warnings: r.warnings.slice(0, 50),
    statementDate: l.statement!.statementDate,
    monthEnd: l.monthEnd,
  };
}

/** WRITE phase: replace the items subcollection with the freshly computed items. */
export function writeItems(tx: Transaction, l: LoadedRecon, r: BankReconRun): void {
  const ref = db.collection(COL.bankReconciliations).doc(l.id);
  const keep = new Set(r.items.map((i) => String(i.seq).padStart(4, '0')));
  l.itemIds.forEach((id) => !keep.has(id) && tx.delete(ref.collection('items').doc(id)));
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
