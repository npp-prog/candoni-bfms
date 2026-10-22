import { COL } from '../constants/collections';
import type { BankMemoDoc, BankReconciliationDoc, BankStatementDoc } from '../types/bank';
import type { BarangayId, Centavos, IsoDate, ReturnInfo, Ts } from '../types/common';
import type { LineClass, ManualMatch, ManualReconItem, MemoCategory, ReconAda, ReconCheck, ReconDeposit, ReconMatch, ReconMemo, StatementLine } from '../accounting/bankMatching';
import type { CheckDoc, DepositDoc } from '../types/treasury';
import type { SourceModuleDef } from './types';

export * from '../accounting/bankMatching';

/**
 * Phase 9 — bank statements, two-sided bank reconciliation, debit/credit memos (RBDCM).
 * Statements and reconciliations are one document per bank account and month (deterministic ids);
 * memos are source documents whose "Generate JEV" creates a DRAFT JCT entry (docs 04 §9).
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

/** bankReconciliations/{bid}_{bankAccountId}_{fy}_{mm} (+ items/{seq}). */
export interface BankReconciliationRecord extends BankReconciliationDoc {
  statementId: string;
  statementDate: IsoDate;
  monthEnd: IsoDate;
  /** Person-made inputs, re-applied on every Prepare. */
  classifications: Record<string, LineClass>;
  manualItems: ManualReconItem[];
  manualMatches: ManualMatch[];
  /** Output of the last Prepare. */
  matches: ReconMatch[];
  itemCount: number;
  unmatchedLineCount: number;
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
    { action: 'ACCEPT', label: 'Generate JEV', from: ['DRAFT'], to: 'ACCEPTED', permission: 'jev.prepare', tone: 'primary', confirm: 'Assigns the BM number and creates a DRAFT JCT journal entry for review, approval and posting.' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT'], to: 'VOID', permission: 'recon.prepare', requiresReason: true, tone: 'danger' },
  ],
};

export const BANK_MODULES: SourceModuleDef[] = [BANK_MEMO_MODULE];

export const RECON_STATUSES = ['DRAFT', 'FOR_REVIEW', 'RETURNED', 'FINAL'] as const;

// ------------------------------------------------------------------ document → reconciliation input
// One mapping for the server (prepare/finalize) and the workspace preview, so both see the same data.

type AdaLike = { adaDate?: string; date?: string; adaNumber?: string; number?: string; amount: number; payee?: { name?: string }; payeeName?: string; status: string; clearedDate?: string | null };

export function toReconCheck(id: string, c: CheckDoc): ReconCheck {
  return { id, checkNumber: c.checkNumber, checkDate: c.checkDate, amount: c.amount, payeeName: c.payee?.name ?? '', dvId: c.dvId ?? null, status: c.status, clearedDate: c.clearedDate ?? null };
}

export function toReconDeposit(id: string, d: DepositDoc & { bankReconciledDate?: string | null }): ReconDeposit {
  return { id, depositDate: d.depositDate, amount: (d.validatedAmount ?? d.amount) as Centavos, reference: d.depositSlipNumber ?? '', status: d.status, bankReconciledDate: d.bankReconciledDate ?? null };
}

/** ADA documents belong to Phase 5; the likely field names are read defensively (null = undated). */
export function toReconAda(id: string, raw: unknown): ReconAda | null {
  const a = raw as AdaLike;
  const date = a.adaDate ?? a.date;
  return date ? { id, adaDate: date, adaNumber: a.adaNumber ?? a.number ?? '', amount: a.amount as Centavos, payeeName: a.payee?.name ?? a.payeeName ?? '', status: a.status, clearedDate: a.clearedDate ?? null } : null;
}

export function toReconMemo(id: string, m: Partial<BankMemoRecord> & Pick<BankMemoRecord, 'memoType' | 'memoDate' | 'amount' | 'status'>): ReconMemo {
  return { id, memoType: m.memoType, category: m.category ?? 'OTHER', memoDate: m.memoDate, amount: m.amount, memoNumber: m.memoNumber ?? null, bankReference: m.bankReference ?? '', particulars: m.particulars ?? '', statementLineId: m.statementLineId ?? null, posted: !!m.jevNumber, jevId: m.jevId ?? null, status: m.status };
}

/** Uncleared check statuses (legacy imports use OUTSTANDING/STALE) — the server's query filter. */
export const OPEN_CHECK_STATUSES = ['ISSUED', 'RELEASED', 'OUTSTANDING', 'STALE'] as const;
