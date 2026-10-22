import { describe, expect, it } from 'vitest';
import {
  BfmsError,
  LIQUIDATION_MODULE,
  PETTY_CASH_VOUCHER_MODULE,
  assertPettyCashAvailable,
  caAddDays,
  caBucketIndex,
  caLiquidationDueDate,
  caOutstandingAsOf,
  computeLiquidation,
  liquidationJevLines,
  normalizeAgingSettings,
  pettyCashEffect,
  stfStatusFor,
  transitionsFrom,
  validateJournalBalance,
  type Centavos,
} from '../src';

const c = (n: number) => n as Centavos;

describe('cash advance aging settings', () => {
  it('reads the seeded systemSettings/aging (1,000,000 = open-ended)', () => {
    const s = normalizeAgingSettings({ buckets: [{ maxDays: 1_000_000, label: 'Over 1 year' }, { maxDays: 30, label: '0-30 days' }], liquidationDueDays: { PAYROLL: 5 } });
    expect(s.buckets.map((b) => b.label)).toEqual(['0-30 days', 'Over 1 year']);
    expect(s.buckets[1]!.maxDays).toBe(Number.POSITIVE_INFINITY);
    expect(s.liquidationDueDays.PAYROLL).toBe(5);
    expect(s.liquidationDueDays.OFFICIAL_TRAVEL).toBe(30);
    expect(normalizeAgingSettings(undefined).buckets).toHaveLength(6);
  });
  it('computes due dates across month/year ends', () => {
    expect(caAddDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(caAddDays('2026-12-20', 20)).toBe('2027-01-09');
    expect(caLiquidationDueDate('2026-03-01', 'PAYROLL', normalizeAgingSettings(undefined))).toBe('2026-03-06');
  });
  it('places days in buckets', () => {
    const b = normalizeAgingSettings(undefined).buckets;
    expect(caBucketIndex(0, b)).toBe(0);
    expect(caBucketIndex(31, b)).toBe(1);
    expect(caBucketIndex(5000, b)).toBe(5);
  });
});

describe('cash advance outstanding as of a date', () => {
  const ca = { amountGranted: c(1_000_000), grantDate: '2026-03-01', openingLiquidated: c(100_000) };
  const mv = [{ date: '2026-03-20', supported: c(300_000), refunded: c(0) }, { date: '2026-04-05', supported: c(500_000), refunded: c(100_000) }];
  it('applies only movements up to the date', () => {
    expect(caOutstandingAsOf(ca, mv, '2026-02-28')).toBeNull();
    expect(caOutstandingAsOf(ca, mv, '2026-03-19')).toBe(900_000);
    expect(caOutstandingAsOf(ca, mv, '2026-03-31')).toBe(600_000);
    expect(caOutstandingAsOf(ca, mv, '2026-04-30')).toBe(0);
  });
});

describe('liquidation', () => {
  it('builds a balanced GJ entry with the refund', () => {
    const items = [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: c(250_000), particulars: 'Bond paper' }, { accountCode: '5-02-01-010', subsidiaryId: null, amount: c(150_000), particulars: 'Fare' }];
    const lines = liquidationJevLines({ items, cashRefunded: c(100_000), refundCashSubsidiaryId: 'AGBOY_1-01-01-010_BT01', caAccountCode: '1-03-03-020', officerSubsidiaryId: 'AGBOY_1-03-03-020_EO01' });
    expect(validateJournalBalance(lines).totalDebit).toBe(500_000);
    expect(lines.at(-1)).toMatchObject({ accountCode: '1-03-03-020', subsidiaryId: 'AGBOY_1-03-03-020_EO01', credit: 500_000 });
    expect(lines.find((l) => l.accountCode === '1-01-01-010')?.debit).toBe(100_000);
  });
  it('needs the collecting officer for a refund', () => {
    expect(() => liquidationJevLines({ items: [], cashRefunded: c(1), refundCashSubsidiaryId: null, caAccountCode: '1-03-03-020', officerSubsidiaryId: 'x' })).toThrow(BfmsError);
  });
  it('rejects expenditures plus refund above the outstanding balance', () => {
    expect(() => computeLiquidation({ cashAdvanceOutstanding: c(500), itemAmounts: [c(400)], cashRefunded: c(101) })).toThrow(/exceed the outstanding/);
    expect(computeLiquidation({ cashAdvanceOutstanding: c(500), itemAmounts: [c(400)], cashRefunded: c(100) }).fullyLiquidated).toBe(true);
  });
  it('follows the standard workflow: treasurer → PB → accounting', () => {
    expect(transitionsFrom(LIQUIDATION_MODULE, 'SUBMITTED').map((t) => t.action)).toEqual(['APPROVE', 'RETURN', 'VOID']);
    expect(transitionsFrom(LIQUIDATION_MODULE, 'APPROVED').map((t) => t.action)).toContain('ACCEPT');
    expect(LIQUIDATION_MODULE.jevSource).toBe('LIQUIDATION');
  });
});

describe('petty cash', () => {
  it('counts only paid / effective transactions', () => {
    expect(pettyCashEffect({ kind: 'PAYMENT', status: 'SUBMITTED', date: '2026-03-02', amount: c(10) })).toBeNull();
    expect(pettyCashEffect({ kind: 'PAYMENT', status: 'APPROVED', date: '2026-03-02', amount: c(10) })).toEqual({ date: '2026-03-02', receipt: 0, payment: 10 });
    expect(pettyCashEffect({ kind: 'REPLENISH', status: 'APPROVED', date: '2026-03-02', amount: c(10) })).toBeNull();
    expect(pettyCashEffect({ kind: 'REPLENISH', status: 'ACCEPTED', date: '2026-03-02', amount: c(10), replenishedDate: '2026-03-09' })).toEqual({ date: '2026-03-09', receipt: 10, payment: 0 });
  });
  it('keeps cash on hand non-negative', () => {
    expect(() => assertPettyCashAvailable(c(500), c(501))).toThrow(/exceeds the petty cash on hand/);
    expect(() => assertPettyCashAvailable(c(500), c(500))).not.toThrow();
  });
  it('PCV approval is by the Punong Barangay with segregation', () => {
    const a = PETTY_CASH_VOUCHER_MODULE.transitions.find((t) => t.action === 'APPROVE')!;
    expect(a.permission).toBe('transaction.approve');
    expect(a.segregation).toBe(true);
  });
});

describe('special trust fund status', () => {
  it('derives status from the balance', () => {
    expect(stfStatusFor(c(1), 'FULLY_UTILIZED')).toBe('ACTIVE');
    expect(stfStatusFor(c(0), 'ACTIVE')).toBe('FULLY_UTILIZED');
    expect(stfStatusFor(c(0), 'ACTIVE', 'RETURN')).toBe('RETURNED');
    expect(stfStatusFor(c(5), 'CLOSED')).toBe('CLOSED');
  });
});
