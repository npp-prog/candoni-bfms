import { COL } from '../constants/collections';
import { lastDayOfMonth } from '../accounting/periods';
import {
  bookBalanceFromRows,
  bookItemsFromJournal,
  reconcileBank,
  type BankReconResult,
  type BookItem,
  type BookLine,
  type CancelledCheckRecord,
  type LineClass,
  type ManualMatch,
  type ManualReconItem,
  type MemoCategory,
  type OpeningCheck,
  type OpeningDeposit,
  type ReconMatch,
  type ReconMemo,
  type StatementLine,
} from '../accounting/bankMatching';
import type { DataSource, WithId } from '../reports/datasource';
import type { AccountBalanceDoc, JournalEntryDoc, JournalLineDoc } from '../types/accounting';
import type { BankAccountDoc, BankMemoDoc, BankReconciliationDoc, BankStatementDoc } from '../types/bank';
import type { BarangayId, Centavos, IsoDate, ReturnInfo, Ts } from '../types/common';
import type { SourceModuleDef } from './types';

export * from '../accounting/bankMatching';

/**
 * Bank reconciliation from the JOURNAL (the barangay books kept by the Municipal Accounting Office):
 * bank statements, prior-year outstanding items, the two-sided reconciliation with Schedule 1
 * (checks issued) and Schedule 2 (deposits), and debit/credit memos (RBDCM) whose "Generate JEV"
 * creates a DRAFT journal entry. Statements and reconciliations are one document per bank account
 * and month (deterministic ids).
 */

export const CASH_IN_BANK = '1-01-02-010';
/** Dr Bank Charges / Cr Cash in Bank (docs 04 §9 "Bank debit/credit memo"). */
export const BANK_CHARGES_ACCOUNT = '5-03-01-020';
/**
 * The barangay chart (coaSeed) has no separate Interest Income account; interest on deposits is
 * business income, so it defaults to 4-04-02-990 Other Business Income until the Municipal
 * Accountant adds a dedicated account and reclassifies on the memo.
 */
export const INTEREST_INCOME_ACCOUNT = '4-04-02-990';

export const MEMO_CATEGORIES: ReadonlyArray<{ value: MemoCategory; label: string }> = [
  { value: 'BANK_CHARGES', label: 'Bank charges / service fee' },
  { value: 'INTEREST_INCOME', label: 'Interest earned' },
  { value: 'OTHER', label: 'Other' },
];

/** Default classification account for a memo (accounting may change it before generating the JEV). */
export function defaultMemoAccount(memoType: 'DEBIT' | 'CREDIT', category: MemoCategory): string | null {
  if (memoType === 'DEBIT' && category === 'BANK_CHARGES') return BANK_CHARGES_ACCOUNT;
  if (memoType === 'CREDIT' && category === 'INTEREST_INCOME') return INTEREST_INCOME_ACCOUNT;
  return null;
}

/** `{bid}_{bankAccountId}_{fy}_{mm}`; month 0 is the opening position of the year (prior-year items). */
export function bankPeriodDocId(barangayId: BarangayId, bankAccountId: string, fiscalYear: number, month: number): string {
  return `${barangayId}_${bankAccountId}_${fiscalYear}_${String(month).padStart(2, '0')}`;
}

/** bankStatements/{bid}_{bankAccountId}_{fy}_{mm} — lines kept in the document (≤ 1,000 per month). */
export interface BankStatementRecord extends BankStatementDoc {
  month: number;
  lines: StatementLine[];
  lineCount: number;
  totalDebits: Centavos;
  totalCredits: Centavos;
  /** beginning + credits − debits */
  computedEndingBalance: Centavos;
  /** computedEndingBalance === endingBalance; a reconciliation needs a balanced statement. */
  balanced: boolean;
}

export const MAX_STATEMENT_LINES = 1000;
export const MAX_OPENING_ITEMS = 500;

/**
 * bankStatements/{bid}_{bankAccountId}_{fy}_00 — the reconciliation set-up of the year: checks
 * and deposits outstanding on January 1 (legacy Schedule 1 "Prior Years"). They are inside the
 * opening book balance (period 00) and stay on Schedule 1 until the bank clears them. Kept in the
 * statements collection (month 00) so it shares its read rules.
 */
export interface BankOpeningRecord {
  kind: 'OPENING';
  barangayId: BarangayId;
  fiscalYear: number;
  month: 0;
  bankAccountId: string;
  /** Bank balance on January 1 (optional cross-check: bank − book = OC − DIT). */
  bankBalance: Centavos | null;
  outstandingChecks: OpeningCheck[];
  depositsInTransit: OpeningDeposit[];
  totalOutstandingChecks: Centavos;
  totalDepositsInTransit: Centavos;
  remarks: string;
  updatedAt: Ts;
  updatedBy: string;
}

/** bankReconciliations/{bid}_{bankAccountId}_{fy}_{mm} (+ items/{seq}). */
export interface BankReconciliationRecord extends BankReconciliationDoc {
  statementId: string;
  statementDate: IsoDate;
  monthEnd: IsoDate;
  /** Person-made inputs, re-applied on every Prepare (later months inherit classifications and matches). */
  classifications: Record<string, LineClass>;
  manualItems: ManualReconItem[];
  manualMatches: ManualMatch[];
  /** Output of the last Prepare. */
  matches: ReconMatch[];
  itemCount: number;
  unmatchedLineCount: number;
  outstandingCheckCount?: number;
  checksIssuedCount?: number;
  bankName: string;
  accountNumber: string;
  subsidiaryId: string;
  preparedAt: Ts | null;
  submittedBy?: string | null;
  submittedAt?: Ts | null;
  returnInfo?: ReturnInfo | null;
  returnHistory?: ReturnInfo[];
  revisionNumber: number;
  remarks: string;
}

/** bankMemos/{id} — fields beyond the frozen BankMemoDoc. */
export interface BankMemoRecord extends Omit<BankMemoDoc, 'memoNumber'> {
  memoNumber: string | null; // BM-YYYY-MM-NNN, assigned at "Generate JEV"
  category: MemoCategory;
  bankReference: string; // the bank's DM/CM or transaction reference
  statementId: string | null;
  statementLineId: string | null;
  accountingPeriod: string;
  status: 'DRAFT' | 'ACCEPTED' | 'VOID';
  jevNumber?: string | null; // stamped when the JEV is posted
  postedAt?: Ts | null;
  revisionNumber: number;
}

export const BANK_MEMO_MODULE: SourceModuleDef = {
  key: 'bankMemo',
  collection: COL.bankMemos,
  label: 'Bank memo',
  dateField: 'memoDate',
  numberField: 'memoNumber',
  encodePermission: 'recon.prepare',
  editableStatuses: ['DRAFT'],
  jevSource: 'BANK_MEMO',
  transitions: [
    { action: 'ACCEPT', label: 'Generate JEV', from: ['DRAFT'], to: 'ACCEPTED', permission: 'jev.prepare', tone: 'primary', confirm: 'Assigns the BM number and creates a DRAFT journal entry for review and posting.' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT'], to: 'VOID', permission: 'recon.prepare', requiresReason: true, tone: 'danger' },
  ],
};

export const BANK_MODULES: SourceModuleDef[] = [BANK_MEMO_MODULE];

export const RECON_STATUSES = ['DRAFT', 'FOR_REVIEW', 'RETURNED', 'FINAL'] as const;

export function toReconMemo(id: string, m: Partial<BankMemoRecord> & Pick<BankMemoRecord, 'memoType' | 'memoDate' | 'amount' | 'status'>): ReconMemo {
  return { id, memoType: m.memoType, category: m.category ?? 'OTHER', memoDate: m.memoDate, amount: m.amount, memoNumber: m.memoNumber ?? null, bankReference: m.bankReference ?? '', particulars: m.particulars ?? '', statementLineId: m.statementLineId ?? null, posted: !!m.jevNumber, jevId: m.jevId ?? null, status: m.status };
}

// ------------------------------------------------------------------ loading (one loader for server, UI, reports)

export interface BankReconPeriod {
  barangayId: BarangayId;
  bankAccountId: string;
  fiscalYear: number;
  month: number;
}

export interface BankReconData {
  period: BankReconPeriod;
  id: string;
  monthStart: IsoDate;
  monthEnd: IsoDate;
  bank: WithId<BankAccountDoc>;
  /** This month's statement. */
  statement: WithId<BankStatementRecord> | null;
  /** Statements of months 1..month (missing months omitted). */
  statements: WithId<BankStatementRecord>[];
  opening: WithId<BankOpeningRecord> | null;
  recon: WithId<BankReconciliationRecord> | null;
  /** Reconciliations of months 1..month-1 (their classifications / matches carry forward). */
  priorRecons: WithId<BankReconciliationRecord>[];
  bookLines: BookLine[];
  reversed: Array<{ jevId: string; reversedByJevId: string | null }>;
  cancelled: Array<CancelledCheckRecord & { id: string }>;
  memos: WithId<BankMemoRecord>[];
  bookBalance: Centavos;
  /** Opening book balance (period 00) of the ledger — for the Jan 1 cross-check. */
  openingBookBalance: Centavos;
}

/** Fetch-or-null: a client `get` of a missing document may be refused by the rules. */
async function tryGet<T>(ds: DataSource, col: string, id: string): Promise<WithId<T> | null> {
  try {
    return await ds.get<T>(col, id);
  } catch {
    return null;
  }
}

/**
 * Everything one month's reconciliation needs, through the report DataSource (browser, Admin SDK
 * or a server transaction). Queries are equality filters on barangay-scoped collections.
 */
export async function loadBankReconData(ds: DataSource, p: BankReconPeriod): Promise<BankReconData> {
  const bank = await ds.get<BankAccountDoc>(COL.bankAccounts, p.bankAccountId);
  if (!bank || bank.barangayId !== p.barangayId) throw new Error('Bank account not found for this barangay.');
  const id = bankPeriodDocId(p.barangayId, p.bankAccountId, p.fiscalYear, p.month);
  const months = Array.from({ length: p.month + 1 }, (_, m) => m);
  const scope = [['barangayId', '==', p.barangayId]] as const;
  const [stmts, recons, lines, reversed, cancelled, memos, balances] = await Promise.all([
    Promise.all(months.map((m) => tryGet<BankStatementRecord & BankOpeningRecord>(ds, COL.bankStatements, bankPeriodDocId(p.barangayId, p.bankAccountId, p.fiscalYear, m)))),
    Promise.all(months.slice(1).map((m) => tryGet<BankReconciliationRecord>(ds, COL.bankReconciliations, bankPeriodDocId(p.barangayId, p.bankAccountId, p.fiscalYear, m)))),
    ds.listGroup<JournalLineDoc>(
      COL.lines,
      [...scope, ['fiscalYear', '==', p.fiscalYear], ['posted', '==', true], ['accountCode', '==', CASH_IN_BANK], ['subsidiaryId', '==', bank.subsidiaryId]],
      [['jevDate', 'asc']],
    ),
    ds.list<JournalEntryDoc>(COL.journalEntries, [...scope, ['fiscalYear', '==', p.fiscalYear], ['status', '==', 'REVERSED']]),
    ds.list<CancelledCheckRecord>(COL.cancelledChecks, [...scope, ['bankAccountId', '==', p.bankAccountId]]),
    ds.list<BankMemoRecord>(COL.bankMemos, [...scope, ['bankAccountId', '==', p.bankAccountId]]),
    ds.list<AccountBalanceDoc>(COL.accountBalances, [...scope, ['fiscalYear', '==', p.fiscalYear], ['accountCode', '==', CASH_IN_BANK], ['subsidiaryId', '==', bank.subsidiaryId]]),
  ]);
  const opening = stmts[0]?.kind === 'OPENING' ? (stmts[0] as unknown as WithId<BankOpeningRecord>) : null;
  const statements = stmts.slice(1).filter((s): s is WithId<BankStatementRecord & BankOpeningRecord> => !!s && s.kind !== 'OPENING') as WithId<BankStatementRecord>[];
  const allRecons = recons.filter((r): r is WithId<BankReconciliationRecord> => !!r);
  return {
    period: p,
    id,
    monthStart: `${p.fiscalYear}-${String(p.month).padStart(2, '0')}-01`,
    monthEnd: lastDayOfMonth(p.fiscalYear, p.month),
    bank,
    statement: statements.find((s) => s.month === p.month) ?? null,
    statements: statements.sort((a, b) => a.month - b.month),
    opening,
    recon: allRecons.find((r) => r.month === p.month) ?? null,
    priorRecons: allRecons.filter((r) => r.month < p.month).sort((a, b) => a.month - b.month),
    bookLines: lines.map((l) => ({
      jevId: l.jevId, lineNo: l.lineNo, jevNumber: l.jevNumber, jevDate: l.jevDate, accountingPeriod: l.accountingPeriod, entryType: l.entryType, debit: l.debit, credit: l.credit,
      primaryReference: l.primaryReference, secondaryReference: l.secondaryReference, payeeName: l.payeeName ?? null, lineDescription: l.lineDescription ?? '',
    })),
    reversed: reversed.map((j) => ({ jevId: j.id, reversedByJevId: j.reversedByJevId ?? null })),
    cancelled,
    memos: memos.filter((m) => m.fiscalYear === p.fiscalYear),
    bookBalance: bookBalanceFromRows(balances, CASH_IN_BANK, bank.subsidiaryId, p.month),
    openingBookBalance: bookBalanceFromRows(balances, CASH_IN_BANK, bank.subsidiaryId, 0),
  };
}

export interface BankReconInputs {
  classifications: Record<string, LineClass>;
  manualItems: ManualReconItem[];
  manualMatches: ManualMatch[];
}

/** Stored person-made inputs: earlier months' classifications and matches carry forward; this month's win. */
export function storedReconInputs(d: Pick<BankReconData, 'recon' | 'priorRecons'>): BankReconInputs {
  const classifications: Record<string, LineClass> = {};
  const matches = new Map<string, ManualMatch>();
  for (const r of [...d.priorRecons, ...(d.recon ? [d.recon] : [])]) {
    Object.assign(classifications, r.classifications ?? {});
    for (const m of r.manualMatches ?? []) if (m && typeof m.bookKey === 'string') matches.set(m.lineId, m);
  }
  return { classifications, manualItems: d.recon?.manualItems ?? [], manualMatches: [...matches.values()] };
}

/** Book items of the data (journal + cancelled register + prior-year items). */
export function bankBookItems(d: BankReconData, asOf: IsoDate = d.monthEnd): { items: BookItem[]; warnings: string[] } {
  return bookItemsFromJournal({ fiscalYear: d.period.fiscalYear, month: d.period.month, asOf, lines: d.bookLines, reversed: d.reversed, cancelled: d.cancelled, opening: d.opening });
}

export interface BankReconRun extends BankReconResult {
  book: BookItem[];
  warnings: string[];
  hasStatement: boolean;
}

/**
 * Run the reconciliation on loaded data. Bank balance = this month's statement ending balance (no
 * statement: the last statement's ending balance, flagged in `warnings`).
 */
export function runBankRecon(d: BankReconData, inputs: BankReconInputs = storedReconInputs(d), asOf?: IsoDate): BankReconRun {
  const { items: book, warnings } = bankBookItems(d, asOf ?? d.monthEnd);
  const stmts = d.statements;
  for (let m = 1; m <= d.period.month; m++) if (!stmts.some((s) => s.month === m)) warnings.push(`No bank statement for ${d.period.fiscalYear}-${String(m).padStart(2, '0')}; checks it cleared show as outstanding.`);
  for (let k = 1; k < stmts.length; k++)
    if (stmts[k]!.month === stmts[k - 1]!.month + 1 && stmts[k]!.beginningBalance !== stmts[k - 1]!.endingBalance)
      warnings.push(`The ${stmts[k]!.statementPeriod} statement begins at ${(stmts[k]!.beginningBalance / 100).toFixed(2)} but ${stmts[k - 1]!.statementPeriod} ended at ${(stmts[k - 1]!.endingBalance / 100).toFixed(2)}.`);
  for (const s of stmts) if (!s.balanced) warnings.push(`The ${s.statementPeriod} statement lines do not add up to its ending balance.`);
  const last = stmts.at(-1);
  const bankBalance = (d.statement?.endingBalance ?? last?.endingBalance ?? 0) as Centavos;
  const r = reconcileBank({
    fiscalYear: d.period.fiscalYear,
    month: d.period.month,
    asOf,
    bookBalance: d.bookBalance,
    bankBalance,
    book,
    bankLines: stmts.flatMap((s) => s.lines ?? []),
    memos: d.memos.map((m) => toReconMemo(m.id, m)),
    ...inputs,
  });
  // Jan 1 cross-check: bank − book = prior-year outstanding checks − deposits in transit.
  const jan = stmts.find((s) => s.month === 1);
  if (jan && d.opening) {
    const expect = (d.opening.totalOutstandingChecks ?? 0) - (d.opening.totalDepositsInTransit ?? 0);
    const actual = jan.beginningBalance - d.openingBookBalance;
    if (expect !== actual) warnings.push(`January 1: bank ${(jan.beginningBalance / 100).toFixed(2)} − book ${(d.openingBookBalance / 100).toFixed(2)} = ${(actual / 100).toFixed(2)}, but the prior-year outstanding checks less deposits in transit total ${(expect / 100).toFixed(2)}.`);
  } else if (jan && !d.opening && jan.beginningBalance !== d.openingBookBalance)
    warnings.push(`January 1: the bank balance differs from the opening book balance by ${((jan.beginningBalance - d.openingBookBalance) / 100).toFixed(2)} — record the prior-year outstanding checks and deposits in transit.`);
  return { ...r, book, warnings, hasStatement: !!d.statement };
}
