import { describe, expect, it } from 'vitest';
import {
  BfmsError,
  abnormalBalances,
  accountBalanceId,
  allocate,
  applyRateBp,
  assertAppropriationAvailable,
  assertPeriodAllowsPosting,
  assertPeriodTransition,
  assertReconciliationBalanced,
  assertSegregation,
  assertStfAvailable,
  balanceDeltas,
  buildCashbook,
  buildChartOfAccounts,
  buildTrialBalance,
  checkCashFlow,
  checkFinancialPosition,
  computeAppropriationBalance,
  computeBankReconciliation,
  computeCashAdvanceBalance,
  computeLiquidation,
  computeNetAssetsChanges,
  depreciationForMonth,
  findTransition,
  formatDocumentNumber,
  formatPesos,
  JEV_TRANSITIONS,
  parseLegacyNumber,
  parsePesos,
  periodOfDate,
  reconcileSubsidiaries,
  reverseLines,
  totalReconItems,
  validateJournalAccounts,
  validateJournalBalance,
  validateRcd,
  type Centavos,
  type JournalLineInput,
} from '../src';

const c = (n: number) => n as Centavos;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as BfmsError).code;
  }
  return 'NO_ERROR';
};

describe('money', () => {
  it('parses legacy and user formats to exact centavos', () => {
    expect(parsePesos('704,641.67')).toBe(70464167);
    expect(parsePesos('\\-323.44')).toBe(-32344); // Google Sheets markdown export
    expect(parsePesos('(4,693.26)')).toBe(-469326);
    expect(parsePesos('-')).toBe(0);
    expect(parsePesos('₱ 1,200')).toBe(120000);
    expect(parsePesos(0.1 + 0.2)).toBe(30); // float noise does not leak
    expect(parsePesos('2.345')).toBe(235); // half away from zero
    expect(() => parsePesos('12a')).toThrow();
  });
  it('formats with accounting parentheses like the legacy books', () => {
    expect(formatPesos(c(-32344))).toBe('(323.44)');
    expect(formatPesos(c(1021550875))).toBe('10,215,508.75');
    expect(formatPesos(c(0), { dashZero: true })).toBe('-');
  });
  it('applies withholding rates without float drift and allocates exactly', () => {
    expect(applyRateBp(c(2678571), 500)).toBe(133929); // 5% of 26,785.71 = 1,339.2855 → 1,339.29
    expect(allocate(c(100), 3)).toEqual([34, 33, 33]);
    expect(allocate(c(100), 3).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('journal entry validation (debit = credit)', () => {
  const ok: JournalLineInput[] = [
    { accountCode: '5-02-03-050', debit: c(440000), credit: c(0) },
    { accountCode: '1-01-02-010', subsidiaryId: 'AGBOY_1-01-02-010_CIB01', debit: c(0), credit: c(440000) },
  ];
  it('accepts a balanced entry', () => {
    expect(validateJournalBalance(ok)).toMatchObject({ totalDebit: 440000, totalCredit: 440000, balanced: true });
  });
  it('rejects unbalanced, one-sided, both-sided, zero, fractional and negative lines', () => {
    expect(code(() => validateJournalBalance([ok[0]!, { ...ok[1]!, credit: c(439999) }]))).toBe('UNBALANCED_ENTRY');
    expect(code(() => validateJournalBalance([ok[0]!]))).toBe('EMPTY_ENTRY');
    expect(code(() => validateJournalBalance([{ ...ok[0]!, credit: c(1) }, ok[1]!]))).toBe('INVALID_LINE');
    expect(code(() => validateJournalBalance([{ ...ok[0]!, debit: c(0) }, { ...ok[1]!, credit: c(0) }]))).toBe('INVALID_LINE');
    expect(code(() => validateJournalBalance([{ ...ok[0]!, debit: c(10.5) }, ok[1]!]))).toBe('INVALID_LINE');
    expect(code(() => validateJournalBalance([{ ...ok[0]!, debit: c(-1) }, ok[1]!]))).toBe('INVALID_LINE');
  });
  it('validates accounts and subsidiary requirements', () => {
    const coa = new Map(buildChartOfAccounts().map((a) => [a.accountCode, a]));
    const sls = new Map<string, { accountCode: string; barangayId: 'AGBOY' | 'BANGA'; active: boolean }>([
      ['AGBOY_1-01-02-010_CIB01', { accountCode: '1-01-02-010', barangayId: 'AGBOY' as const, active: true }],
      ['BANGA_1-01-02-010_CIB01', { accountCode: '1-01-02-010', barangayId: 'BANGA' as const, active: true }],
    ]);
    expect(() => validateJournalAccounts(ok, 'AGBOY', coa, sls)).not.toThrow();
    expect(code(() => validateJournalAccounts([ok[0]!, { ...ok[1]!, subsidiaryId: null }], 'AGBOY', coa, sls))).toBe('SUBSIDIARY_REQUIRED');
    expect(code(() => validateJournalAccounts([ok[0]!, { ...ok[1]!, subsidiaryId: 'BANGA_1-01-02-010_CIB01' }], 'AGBOY', coa, sls))).toBe('BARANGAY_MISMATCH');
    expect(code(() => validateJournalAccounts([{ ...ok[0]!, accountCode: '9-99-99-999' }, ok[1]!], 'AGBOY', coa, sls))).toBe('INVALID_ACCOUNT');
  });
  it('reversal swaps sides and still balances', () => {
    const r = reverseLines(ok);
    expect(r[0]).toMatchObject({ debit: 0, credit: 440000 });
    expect(validateJournalBalance(r).balanced).toBe(true);
  });
});

describe('chart of accounts seed', () => {
  const coa = buildChartOfAccounts();
  it('has 274 unique accounts with corrected legacy issues', () => {
    expect(coa).toHaveLength(274);
    expect(new Set(coa.map((a) => a.accountCode)).size).toBe(274);
    expect(coa.find((a) => a.accountCode === '1-03-01-011')?.normalBalance).toBe('CREDIT');
    expect(coa.find((a) => a.accountName === 'Other Provisions')?.accountCode).toBe('2-01-02-990');
  });
  it('classifies accounts for statements', () => {
    const by = (k: string) => coa.find((a) => a.accountCode === k)!;
    expect(by('1-01-02-010')).toMatchObject({ isCashAccount: true, requiresSubsidiaryLedger: true, financialStatementClassification: 'SFP.CA.CASH' });
    expect(by('4-01-04-010').financialStatementClassification).toBe('SFPERF.REV.SHARE_IRA');
    expect(by('5-02-10-030').financialStatementClassification).toBe('SFPERF.TRANSFERS_TO');
    expect(by('1-07-06-011')).toMatchObject({ isContra: true, normalBalance: 'CREDIT' });
    expect(coa.filter((a) => a.financialStatementClassification === 'UNMAPPED')).toEqual([]);
    // every contra account has a credit normal balance (except allowance was fixed)
    expect(coa.filter((a) => a.isContra && a.accountType === 'ASSET' && a.normalBalance !== 'CREDIT')).toEqual([]);
  });
});

describe('balances, trial balance, SL reconciliation', () => {
  const coa = new Map(buildChartOfAccounts().map((a) => [a.accountCode, a]));
  const lines = [
    { accountCode: '1-01-01-010', subsidiaryId: 'AGBOY_1-01-01-010_BT02', debit: c(24312000), credit: c(0) },
    { accountCode: '4-01-04-010', subsidiaryId: null, debit: c(0), credit: c(24312000) },
  ];
  const deltas = balanceDeltas('AGBOY', 2026, 1, 'GF', lines);
  it('writes an account roll-up row and an SL row', () => {
    expect(deltas.map((d) => d.id).sort()).toEqual([
      accountBalanceId('AGBOY', 2026, 1, 'GF', '1-01-01-010', null),
      accountBalanceId('AGBOY', 2026, 1, 'GF', '1-01-01-010', 'AGBOY_1-01-01-010_BT02'),
      accountBalanceId('AGBOY', 2026, 1, 'GF', '4-01-04-010', null),
    ].sort());
  });
  it('builds a balanced TB and reconciles SL to GL', () => {
    const rows = deltas.map((d) => ({ ...d, month: 1 }));
    const tb = buildTrialBalance(rows, coa, { throughMonth: 12 });
    expect(tb).toMatchObject({ totalDebit: 24312000, totalCredit: 24312000, balanced: true });
    expect(reconcileSubsidiaries(rows, '1-01-01-010', 'DEBIT')).toMatchObject({ reconciled: true, controlBalance: 24312000 });
  });
  it('flags abnormal balances such as negative cash in local treasury (legacy opening issue)', () => {
    const rows = [
      { accountCode: '1-01-01-010', subsidiaryId: null, debit: c(0), credit: c(469326), month: 0 },
      { accountCode: '3-01-01-010', subsidiaryId: null, debit: c(469326), credit: c(0), month: 0 },
    ];
    const tb = buildTrialBalance(rows, coa, { throughMonth: 0 });
    expect(abnormalBalances(tb).map((r) => r.accountCode)).toContain('1-01-01-010');
  });
});

describe('budget controls', () => {
  it('computes total and available appropriation on the server', () => {
    const r = computeAppropriationBalance({
      originalAppropriation: c(100000000),
      supplementalAppropriation: c(5000000),
      realignment: c(-2000000),
      adjustments: c(0),
      obligations: c(60000000),
    });
    expect(r).toEqual({ totalAppropriation: 103000000, availableBalance: 43000000, utilizationBp: 5825 });
  });
  it('rejects obligations above the available appropriation', () => {
    expect(() => assertAppropriationAvailable(c(1000), c(1000))).not.toThrow();
    expect(code(() => assertAppropriationAvailable(c(1000), c(1001)))).toBe('INSUFFICIENT_APPROPRIATION');
    expect(code(() => assertStfAvailable(c(500), c(501)))).toBe('INSUFFICIENT_STF_BALANCE');
  });
});

describe('cash advances and liquidation', () => {
  const ca = { amountGranted: c(10105800), amountLiquidated: c(0), amountRefunded: c(0), grantDate: '2025-12-27', liquidationDueDate: '2026-01-26' };
  it('computes outstanding balance, aging and status', () => {
    expect(computeCashAdvanceBalance(ca, '2026-01-10')).toMatchObject({ outstandingBalance: 10105800, daysOutstanding: 14, status: 'ACTIVE', agingCategory: '0-30 days' });
    expect(computeCashAdvanceBalance(ca, '2026-09-24')).toMatchObject({ status: 'OVERDUE', agingCategory: '181-365 days' });
    expect(computeCashAdvanceBalance({ ...ca, amountLiquidated: c(10000000), amountRefunded: c(105800) }, '2026-01-10')).toMatchObject({ outstandingBalance: 0, status: 'FULLY_LIQUIDATED' });
    expect(code(() => computeCashAdvanceBalance({ ...ca, amountLiquidated: c(10105801) }, '2026-01-10'))).toBe('LIQUIDATION_NOT_RECONCILED');
  });
  it('reconciles liquidation: CA − supported − refund = balance', () => {
    expect(computeLiquidation({ cashAdvanceOutstanding: c(500000), itemAmounts: [c(300000), c(150000)], cashRefunded: c(50000) })).toEqual({ totalSupported: 450000, balanceRemaining: 0, fullyLiquidated: true });
    expect(computeLiquidation({ cashAdvanceOutstanding: c(500000), itemAmounts: [c(300000)], cashRefunded: c(0) }).fullyLiquidated).toBe(false);
    expect(code(() => computeLiquidation({ cashAdvanceOutstanding: c(500000), itemAmounts: [c(600000)], cashRefunded: c(0) }))).toBe('LIQUIDATION_NOT_RECONCILED');
  });
});

describe('bank reconciliation', () => {
  it('balances adjusted book and bank', () => {
    // Book 3,638.99; bank 48,723.72; outstanding checks 45,084.73 (legacy Agboy Dec 2025 figures)
    const t = totalReconItems([{ category: 'OUTSTANDING_CHECK', amount: c(4508473) }]);
    const r = computeBankReconciliation(c(363899), c(4872372), t);
    expect(r).toMatchObject({ adjustedBookBalance: 363899, adjustedBankBalance: 363899, difference: 0, balanced: true });
  });
  it('blocks finalization when not balanced', () => {
    const t = totalReconItems([{ category: 'BANK_CHARGES', amount: c(120000) }]);
    const r = computeBankReconciliation(c(100000), c(100000), t);
    expect(r.difference).toBe(-120000);
    expect(code(() => assertReconciliationBalanced(r.difference))).toBe('RECONCILIATION_NOT_BALANCED');
  });
});

describe('cashbook and RCD', () => {
  it('rolls forward beginning + receipts − payments = ending', () => {
    const cb = buildCashbook(c(-469326), [
      { date: '2025-01-06', sortKey: 'a', reference: 'RCD 2025-01-001', particulars: 'Collections', receipt: c(28000), payment: c(0) },
      { date: '2025-01-30', sortKey: 'b', reference: 'RCD 2025-01-002', particulars: 'Collections', receipt: c(24312000), payment: c(0) },
      { date: '2025-01-30', sortKey: 'c', reference: 'DS', particulars: 'Deposit', receipt: c(0), payment: c(24000000) },
    ]);
    expect(cb.endingBalance).toBe(-129326);
    expect(cb.valid).toBe(true);
    expect(cb.negativeBalanceDates.length).toBeGreaterThan(0);
  });
  it('validates collections vs deposits', () => {
    expect(validateRcd(c(100), c(100), null).result).toBe('PASSED');
    expect(validateRcd(c(100), c(80), null).result).toBe('FAILED');
    expect(validateRcd(c(100), c(80), 'Collected after banking hours; deposited next day').result).toBe('WARNING');
    expect(validateRcd(c(80), c(100), 'x').result).toBe('FAILED');
  });
});

describe('financial statements', () => {
  it('checks SFP equation and cash flow reconciliation', () => {
    expect(checkFinancialPosition(c(386895223), c(305236649), c(81658574)).balanced).toBe(true);
    expect(checkCashFlow({ beginningCash: c(69994841), operating: c(-69240268), investing: c(0), financing: c(0), cashAccountsEnding: c(754573) }).reconciled).toBe(true);
  });
  it('reproduces the legacy Agboy 2025 SCNA roll-forward', () => {
    const r = computeNetAssetsChanges({ beginningBalance: c(-25688591), priorPeriodAdjustments: c(191000000), changesInAccountingPolicy: c(0), surplusDeficit: c(-83652835) });
    expect(r).toEqual({ restatedBalance: 165311409, endingBalance: 81658574 });
  });
  it('depreciates straight-line and never exceeds depreciable amount', () => {
    // Office equipment 57,075.00, residual 2,853.75 (5%), 5 years → 10,844.25/yr
    const m = depreciationForMonth(c(5707500), c(285375), 5, c(0));
    expect(m * 12).toBeCloseTo(1084425, -2);
    expect(depreciationForMonth(c(5707500), c(285375), 5, c(5422125))).toBe(0);
  });
});

describe('periods, numbering, workflow', () => {
  it('derives period from accounting date and gates posting', () => {
    expect(periodOfDate('2026-09-24')).toEqual({ fiscalYear: 2026, month: 9, key: '2026-09' });
    expect(() => assertPeriodAllowsPosting('OPEN', 'REGULAR')).not.toThrow();
    expect(code(() => assertPeriodAllowsPosting('LOCKED', 'REGULAR'))).toBe('PERIOD_NOT_OPEN');
    expect(code(() => assertPeriodAllowsPosting('CLOSED', 'ADJUSTING'))).toBe('PERIOD_NOT_OPEN');
    expect(code(() => assertPeriodAllowsPosting(undefined, 'REGULAR'))).toBe('PERIOD_NOT_OPEN');
  });
  it('requires a justification to reopen a locked period', () => {
    expect(code(() => assertPeriodTransition('LOCKED', 'OPEN', ''))).toBe('VALIDATION_FAILED');
    expect(() => assertPeriodTransition('LOCKED', 'OPEN', 'COA AOM 2026-015 adjustment on depreciation')).not.toThrow();
    expect(code(() => assertPeriodTransition('CLOSED', 'OPEN', 'long enough reason'))).toBe('INVALID_STATUS');
  });
  it('formats legacy-compatible document numbers', () => {
    expect(formatDocumentNumber('{YYYY}-{MM}-{N:3}', '', 2025, 1, 3)).toBe('2025-01-003');
    expect(formatDocumentNumber('{PREFIX}-{YYYY}-{N:4}', 'PCV', 2026, 9, 12)).toBe('PCV-2026-0012');
    expect(parseLegacyNumber('2025-03-038')).toEqual({ fiscalYear: 2025, month: 3, n: 38 });
  });
  it('enforces JEV transitions and segregation of duties', () => {
    expect(findTransition(JEV_TRANSITIONS, 'POST', 'APPROVED').to).toBe('POSTED');
    expect(code(() => findTransition(JEV_TRANSITIONS, 'POST', 'DRAFT'))).toBe('INVALID_STATUS');
    expect(code(() => findTransition(JEV_TRANSITIONS, 'POST', 'POSTED'))).toBe('INVALID_STATUS');
    expect(code(() => assertSegregation('u1', 'u1', 'POST'))).toBe('SEGREGATION_OF_DUTIES');
    expect(() => assertSegregation('u1', 'u2', 'POST')).not.toThrow();
  });
});
