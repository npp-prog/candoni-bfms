import type { JevStatus } from '../constants/statuses';
import type { BarangayId, Centavos, FundId, IsoDate, PeriodKey, PeriodScoped, Ts, WorkflowTracked } from './common';

export type JournalBook = 'JCT' | 'GJ';

export type EntryType = 'REGULAR' | 'ADJUSTING' | 'CORRECTING' | 'REVERSING' | 'CLOSING' | 'OPENING';

export type SourceModule =
  | 'MANUAL'
  | 'COLLECTION'
  | 'RCD'
  | 'DEPOSIT'
  | 'DV'
  | 'CHECK'
  | 'PAYROLL'
  | 'CASH_ADVANCE'
  | 'LIQUIDATION'
  | 'PETTY_CASH'
  | 'STF'
  | 'BANK_MEMO'
  | 'DEPRECIATION'
  | 'INVENTORY'
  | 'CLOSING'
  | 'IMPORT';

/** journalEntries/{jevId} */
export interface JournalEntryDoc extends PeriodScoped, WorkflowTracked<JevStatus> {
  jevNumber: string | null; // assigned at POST: YYYY-MM-NNN
  jevDate: IsoDate;
  fundId: FundId;
  journal: JournalBook;
  entryType: EntryType;
  sourceModule: SourceModule;
  sourceDocumentId: string | null;
  primaryReference: string | null; // check / OR no.
  secondaryReference: string | null; // DV / RCD no.
  tertiaryReference: string | null;
  particulars: string;
  totalDebit: Centavos; // server
  totalCredit: Centavos; // server
  lineCount: number; // server
  reversesJevId: string | null;
  reversedByJevId: string | null;
}

/** journalEntries/{jevId}/lines/{lineId} — denormalized for collection-group GL/SL queries. */
export interface JournalLineDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  accountingPeriod: PeriodKey;
  fundId: FundId;
  jevId: string;
  jevDate: IsoDate;
  jevNumber: string | null;
  journal: JournalBook;
  entryType: EntryType;
  posted: boolean;
  lineNo: number;
  accountCode: string;
  subsidiaryId: string | null;
  debit: Centavos;
  credit: Centavos;
  lineDescription: string;
  primaryReference: string | null;
  secondaryReference: string | null;
  payeeName: string | null;
  fppId: string | null;
  officeId: string | null;
}

/** Input line as supplied by preparers (before server enrichment). */
export interface JournalLineInput {
  accountCode: string;
  subsidiaryId?: string | null;
  debit: Centavos;
  credit: Centavos;
  lineDescription?: string;
  fppId?: string | null;
  officeId?: string | null;
}

/**
 * accountBalances/{bid}_{fy}_{mm}_{fund}_{account}_{sl|-}
 * Period MOVEMENTS (not cumulative). Opening balances in month 00; closing in 13.
 */
export interface AccountBalanceDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  month: number;
  accountingPeriod: PeriodKey;
  fundId: FundId;
  accountCode: string;
  subsidiaryId: string | null; // null row = account roll-up
  debit: Centavos;
  credit: Centavos;
  lineCount: number;
  updatedAt: Ts;
}

/** numberSequences/{bid}_{fy}_{docType} */
export interface NumberSequenceDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  documentType: string;
  currentNumber: number;
  prefix: string;
  format: string; // tokens: {PREFIX} {YYYY} {MM} {N:3}
  updatedAt: Ts;
}

/** uniqueKeys/{key} — Firestore has no unique index; a create() collision = duplicate. */
export interface UniqueKeyDoc {
  key: string;
  collection: string;
  documentId: string;
  barangayId: BarangayId | 'ALL';
  createdAt: Ts;
}

/** financialSummaries/{bid}_{fy} — dashboard counters maintained by trusted server logic. */
export interface FinancialSummaryDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  cashInLocalTreasury: Centavos;
  cashInBank: Centavos;
  totalRevenue: Centavos;
  totalExpenses: Centavos;
  totalAppropriation: Centavos;
  totalObligations: Centavos;
  stfBalance: Centavos;
  unliquidatedCashAdvances: Centavos;
  overdueCashAdvances: Centavos;
  outstandingChecks: Centavos;
  bankReconDifference: Centavos;
  reportsDue: number;
  reportsReturned: number;
  reportsPendingReview: number;
  lastSubmittedPeriod: PeriodKey | null;
  monthly: Array<{ month: number; collections: Centavos; disbursements: Centavos; revenue: Centavos; expenses: Centavos }>;
  updatedAt: Ts;
}
