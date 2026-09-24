import type { BarangayId, BarangayScoped, Centavos, IsoDate, PeriodKey, Ts, Tracked } from './common';

/** bankAccounts/{id} */
export interface BankAccountDoc extends Tracked {
  barangayId: BarangayId;
  bankName: string; // Land Bank of the Philippines
  branch: string; // Kabankalan City
  accountName: string; // AGBOY BRGY COUNCIL-CANDONI
  accountNumber: string; // stored in full; masked in UI & reports lists
  accountType: 'CURRENT' | 'SAVINGS' | 'TIME_DEPOSIT';
  fundId: string;
  glAccountCode: string; // 1-01-02-010
  subsidiaryId: string; // AGBOY_1-01-02-010_CIB01
  active: boolean;
}

/** bankStatements/{id} (+ lines subcollection) */
export interface BankStatementDoc extends BarangayScoped, Tracked {
  bankAccountId: string;
  statementPeriod: PeriodKey;
  statementDate: IsoDate;
  beginningBalance: Centavos;
  endingBalance: Centavos;
  attachmentId: string | null;
  source: 'MANUAL' | 'IMPORT';
}

export type ReconItemCategory =
  | 'DEPOSIT_IN_TRANSIT'
  | 'OUTSTANDING_CHECK'
  | 'BANK_DEBIT_MEMO'
  | 'BANK_CREDIT_MEMO'
  | 'BANK_CHARGES'
  | 'INTEREST_INCOME'
  | 'BOOK_ERROR'
  | 'BANK_ERROR'
  | 'OTHER_BOOK'
  | 'OTHER_BANK';

export interface ReconItem {
  category: ReconItemCategory;
  date: IsoDate;
  reference: string;
  name: string;
  /** Signed centavos. + increases the side it adjusts, − decreases it. */
  amount: Centavos;
  sourceType: 'CHECK' | 'DEPOSIT' | 'BANK_MEMO' | 'MANUAL';
  sourceId: string | null;
  remarks: string;
  requiresJev: boolean;
  jevId: string | null;
}

/** bankReconciliations/{bid}_{bankAccountId}_{fy}_{mm} */
export interface BankReconciliationDoc extends BarangayScoped, Tracked {
  bankAccountId: string;
  month: number;
  bookBalance: Centavos; // from GL (server)
  bankBalance: Centavos; // from statement
  depositInTransit: Centavos;
  outstandingChecks: Centavos;
  debitMemos: Centavos;
  creditMemos: Centavos;
  bankCharges: Centavos;
  interestIncome: Centavos;
  bookErrors: Centavos; // signed
  bankErrors: Centavos; // signed
  otherBookItems: Centavos; // signed
  otherBankItems: Centavos; // signed
  adjustedBookBalance: Centavos;
  adjustedBankBalance: Centavos;
  difference: Centavos;
  status: 'DRAFT' | 'FOR_REVIEW' | 'RETURNED' | 'FINAL';
  preparedBy: string | null;
  finalizedBy: string | null;
  finalizedAt: Ts | null;
}

/** bankMemos/{id} — Report of Bank Debit and Credit Memos */
export interface BankMemoDoc extends BarangayScoped, Tracked {
  bankAccountId: string;
  memoType: 'DEBIT' | 'CREDIT';
  memoDate: IsoDate;
  memoNumber: string;
  particulars: string;
  amount: Centavos;
  classificationAccountCode: string | null; // set by Municipal Accounting
  jevId: string | null;
}
