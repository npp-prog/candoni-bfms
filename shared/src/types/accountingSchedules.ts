import type { BarangayId, Centavos, IsoDate, Ts } from './common';

/**
 * Accounting-system data that is not a journal entry (docs: barangay books kept by the Municipal
 * Accounting Office). Shared contracts between the workbook import, the schedules and the
 * statements. All are server-written (callables); clients read them.
 */

/**
 * legacyBalances/{bid}_{fy} — a prior year's PRE-CLOSING trial balance carried from the legacy
 * workbook (02.2_PRETB_3Y). Statements use it for comparative columns when that year has no
 * BFMS postings. Signed per account: debit − credit.
 */
export interface LegacyBalanceDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  kind: 'PRE_CLOSING_TB';
  rows: Array<{ accountCode: string; debit: Centavos; credit: Centavos }>;
  source: string; // workbook title
  importedAt: Ts;
  importedBy: string;
}

/**
 * legacyCashAdvances/{auto} — an advance granted before BFMS (the legacy "List of Unliquidated
 * Cash Advances"). Its amount is already inside the opening balance of the account/SL; the CA
 * schedule lists it so aging stays per advance.
 */
export interface LegacyCashAdvanceDoc {
  barangayId: BarangayId;
  /** Fiscal year whose opening balance includes this advance. */
  fiscalYear: number;
  accountCode: string; // 1-03-03-010 | 1-03-03-020 | 1-03-04-… (due from officers)
  subsidiaryId: string | null; // AO## / EO## ledger when known
  officerName: string;
  date: IsoDate;
  checkNumber: string | null;
  dvNumber: string | null;
  particulars: string;
  amount: Centavos; // outstanding as of the opening date (negative = over-liquidated)
  source: string;
  createdAt: Ts;
  createdBy: string;
}

/**
 * ppeSchedules/{bid}_{fy} — straight-line depreciation parameters per PPE account
 * (legacy "PPE Depreciation Schedule": cost, residual 0 % or 5 %, life 5 or 10 years).
 * Cost defaults to the GL balance of the account at year end unless overridden.
 */
export interface PpeScheduleDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  rows: PpeScheduleRow[];
  updatedAt: Ts;
  updatedBy: string;
}

export interface PpeScheduleRow {
  accountCode: string; // 1-07-xx-xxx
  /** Override of the depreciable cost (null = GL balance). */
  costOverride: Centavos | null;
  residualRateBp: number; // 500 = 5 %
  usefulLifeYears: number;
  accumulatedAccountCode: string; // 1-07-xx-xx1
  expenseAccountCode: string; // 5-04-01-0x0
  remarks: string;
}

/**
 * bankStatements/{bid}_{bankAccountId}_{fy}_{mm} lines (legacy 04.2_ChecksEncashed): the bank
 * side of the reconciliation. Debit = checks encashed / bank charges; credit = deposits / credit
 * memos. Owned by the bank module; listed here so the import can fill it.
 */
export interface BankStatementLineInput {
  date: IsoDate;
  checkNumber: string | null;
  reference: string;
  description: string;
  debit: Centavos;
  credit: Centavos;
}
