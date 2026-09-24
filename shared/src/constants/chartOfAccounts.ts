import type { AccountType, CashFlowClass, ChartOfAccountDoc } from '../types/coa';
import { COA_SEED } from './coaSeed';

const TYPE_BY_DIGIT: Record<string, AccountType> = {
  '1': 'ASSET',
  '2': 'LIABILITY',
  '3': 'EQUITY',
  '4': 'REVENUE',
  '5': 'EXPENSE',
};

/**
 * Accounts that carry subsidiary ledgers in the legacy books
 * (BT##, CIB##, LGU##, AO##, EO##, OR##, AP##, BIR##, NGA## codes).
 * Prefix match on account code.
 */
const SL_REQUIRED_PREFIXES = [
  '1-01-01-010', // Cash - In Local Treasury (per accountable officer)
  '1-01-01-020', // Petty Cash (per custodian)
  '1-01-02-010', // Cash in Bank (per bank account)
  '1-03-01-010',
  '1-03-02-010',
  '1-03-03-010', // Advances for Payroll (per AO)
  '1-03-03-020', // Advances to Officers and Employees
  '1-03-04-',
  '1-05-01-010',
  '2-01-01-010',
  '2-01-01-020',
  '2-02-01-',
  '2-03-01-',
  '2-99-99-990',
];

/** Default financial-statement line (SFP / SFPerf) by account-group prefix, longest match wins. */
const FS_LINE_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['1-01', 'SFP.CA.CASH'],
  ['1-02', 'SFP.CA.INVESTMENTS'],
  ['1-03', 'SFP.CA.RECEIVABLES'],
  ['1-04', 'SFP.CA.INVENTORIES'],
  ['1-05', 'SFP.CA.PREPAYMENTS'],
  ['1-06', 'SFP.NCA.INVESTMENT_PROPERTY'],
  ['1-07', 'SFP.NCA.PPE'],
  ['1-08', 'SFP.NCA.BIOLOGICAL_ASSETS'],
  ['2-01', 'SFP.CL.FINANCIAL_LIABILITIES'],
  ['2-01-03', 'SFP.NCL.LOANS'],
  ['2-02', 'SFP.CL.INTER_AGENCY_PAYABLES'],
  ['2-03', 'SFP.CL.TRUST_LIABILITIES'],
  ['2-99', 'SFP.CL.OTHER_PAYABLES'],
  ['3', 'SFP.EQUITY'],
  ['4-01', 'SFPERF.REV.TAX'],
  ['4-01-04-010', 'SFPERF.REV.SHARE_IRA'],
  ['4-02', 'SFPERF.TRANSFERS_FROM'],
  ['4-03-01', 'SFPERF.REV.SHARE_NATIONAL_WEALTH'],
  ['4-03-02', 'SFPERF.REV.GRANTS_DONATIONS'],
  ['4-04', 'SFPERF.REV.SERVICE_BUSINESS'],
  ['4-05', 'SFPERF.REV.GAINS'],
  ['5-01', 'SFPERF.EXP.PERSONNEL_SERVICES'],
  ['5-02', 'SFPERF.EXP.MOOE'],
  ['5-02-10', 'SFPERF.TRANSFERS_TO'],
  ['5-03', 'SFPERF.EXP.FINANCIAL'],
  ['5-04', 'SFPERF.EXP.NON_CASH'],
];

function longestPrefix<T>(code: string, table: ReadonlyArray<readonly [string, T]>): T | null {
  let best: { len: number; v: T } | null = null;
  for (const [p, v] of table) {
    if (code.startsWith(p) && (!best || p.length > best.len)) best = { len: p.length, v };
  }
  return best?.v ?? null;
}

function cashFlowClassFor(code: string): CashFlowClass | null {
  if (code.startsWith('1-01')) return 'CASH';
  if (code.startsWith('5-04')) return 'NON_CASH';
  if (code.startsWith('1-06') || code.startsWith('1-07') || code.startsWith('1-08') || code.startsWith('1-02'))
    return 'INVESTING';
  if (code.startsWith('2-01-03')) return 'FINANCING';
  if (code.startsWith('3')) return null;
  return 'OPERATING';
}

export function buildChartOfAccounts(): ChartOfAccountDoc[] {
  return COA_SEED.map(([accountCode, accountName, normal], i) => {
    const [major, sub, grp] = accountCode.split('-') as [string, string, string, string];
    const isContra = /^(Accumulated|Allowance)/i.test(accountName);
    return {
      accountCode,
      accountName,
      accountType: TYPE_BY_DIGIT[major] ?? 'ASSET',
      majorAccountGroup: major,
      subMajorAccountGroup: `${major}-${sub}`,
      accountGroup: `${major}-${sub}-${grp}`,
      normalBalance: normal === 'D' ? 'DEBIT' : 'CREDIT',
      isContra,
      requiresSubsidiaryLedger: SL_REQUIRED_PREFIXES.some((p) => accountCode.startsWith(p)),
      isCashAccount: accountCode.startsWith('1-01'),
      financialStatementClassification: longestPrefix(accountCode, FS_LINE_BY_PREFIX) ?? 'UNMAPPED',
      cashFlowClassification: cashFlowClassFor(accountCode),
      active: true,
      sortOrder: (i + 1) * 10,
    } satisfies ChartOfAccountDoc;
  });
}

export const COA_REVIEW_NOTES = COA_SEED.filter((r) => r[3]).map(([code, name, , note]) => ({ code, name, note }));
