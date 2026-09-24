import type { BarangayId, FundId, Tracked } from './common';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type CashFlowClass = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NON_CASH' | 'CASH';

/** chartOfAccounts/{accountCode} — maintained by Municipal Accounting only. */
export interface ChartOfAccountDoc {
  accountCode: string; // '1-01-02-010'
  accountName: string;
  accountType: AccountType;
  majorAccountGroup: string; // '1' Assets
  subMajorAccountGroup: string; // '1-01' Cash and Cash Equivalents
  accountGroup: string; // '1-01-02' Cash in Bank
  normalBalance: NormalBalance;
  /** Contra accounts (Accumulated Depreciation, Allowance …). */
  isContra: boolean;
  requiresSubsidiaryLedger: boolean;
  isCashAccount: boolean;
  financialStatementClassification: string; // e.g. 'SFP.CURRENT_ASSETS.CASH'
  cashFlowClassification: CashFlowClass | null;
  active: boolean;
  sortOrder: number;
}

export type SubsidiaryType =
  | 'ACCOUNTABLE_OFFICER'
  | 'EMPLOYEE'
  | 'SUPPLIER'
  | 'BANK'
  | 'RECEIVABLE'
  | 'PAYABLE'
  | 'BIR'
  | 'CASH_ADVANCE'
  | 'SPECIAL_TRUST_FUND'
  | 'GOVERNMENT_AGENCY'
  | 'OTHER';

/** subsidiaryAccounts/{barangayId}_{accountCode}_{subsidiaryCode} */
export interface SubsidiaryAccountDoc extends Tracked {
  barangayId: BarangayId;
  accountCode: string;
  subsidiaryCode: string; // legacy codes: BT01, CIB01, AO02, EO05, BIR01, LGU01 …
  subsidiaryName: string;
  type: SubsidiaryType;
  partyId: string | null;
  active: boolean;
}

export type FundType = 'GENERAL_FUND' | 'SPECIAL_TRUST_FUND';

/** funds/{fundId} */
export interface FundDoc {
  fundId: FundId;
  barangayId: BarangayId | 'ALL';
  fundType: FundType;
  fundCode: string;
  fundName: string;
  active: boolean;
}
