import { describe, expect, it } from 'vitest';
import {
  BfmsError,
  COLLECTIONS_MODULES,
  afAccountability,
  afRangesOverlap,
  assertAfSerialRange,
  assertCollectionLines,
  assertDepositMatches,
  collectionAmount,
  computeAfUsage,
  computeRcdTotals,
  describeAfProblems,
  formatAfSerial,
  isCollectionCounted,
  orBreakdownByAccount,
  parseAfSerial,
  reportBuilder,
  type Centavos,
  type CollectionLine,
} from '../src/index';

const line = (accountCode: string, amount: number, subsidiaryId: string | null = null): CollectionLine => ({ accountCode, subsidiaryId, natureOfCollection: 'x', amount: amount as Centavos });

describe('accountable form serials', () => {
  it('parses and formats pre-printed numbers', () => {
    expect(parseAfSerial('0012345')).toBe(12345);
    expect(formatAfSerial(12345, 7)).toBe('0012345');
    expect(() => parseAfSerial('12A')).toThrow(BfmsError);
  });
  it('validates ranges and overlap', () => {
    expect(() => assertAfSerialRange({ begin: 50, end: 1 })).toThrow(/cannot be lower/);
    expect(() => assertAfSerialRange({ begin: 1, end: 6000 })).toThrow(/at most/);
    expect(afRangesOverlap({ begin: 1, end: 50 }, { begin: 50, end: 100 })).toBe(true);
    expect(afRangesOverlap({ begin: 1, end: 50 }, { begin: 51, end: 100 })).toBe(false);
  });
  it('computes usage, gaps, duplicates and the next serial', () => {
    const u = computeAfUsage({ begin: 101, end: 110 }, [
      { serial: 101, date: '2026-03-01', status: 'DRAFT' },
      { serial: 102, date: '2026-03-01', status: 'CANCELLED' },
      { serial: 104, date: '2026-03-02', status: 'ACCEPTED' },
      { serial: 104, date: '2026-03-02', status: 'DRAFT' },
      { serial: 120, date: '2026-03-02', status: 'DRAFT' },
    ]);
    expect(u.gaps).toEqual([103]);
    expect(u.duplicates).toEqual([104]);
    expect(u.outOfRange).toEqual([120]);
    expect(u.nextSerialNumber).toBe(105);
    expect(u.used).toBe(3);
    expect(u.endingBalance).toBe(7);
    expect(describeAfProblems('AF 51', u)).toMatch(/missing 103.*duplicated 104.*outside the series 120/);
    const full = computeAfUsage({ begin: 1, end: 2 }, [{ serial: 1, date: 'd', status: 'DRAFT' }, { serial: 2, date: 'd', status: 'DRAFT' }]);
    expect(full.exhausted).toBe(true);
    expect(describeAfProblems('x', full)).toBe('');
  });
  it('rolls the accountability forward: beginning + receipts − issued = ending', () => {
    const uses = [
      { serial: 1, date: '2026-02-10', status: 'DRAFT' },
      { serial: 2, date: '2026-03-03', status: 'DRAFT' },
      { serial: 3, date: '2026-03-04', status: 'CANCELLED' },
    ];
    const mar = afAccountability({ begin: 1, end: 50 }, '2026-02-01', uses, { from: '2026-03-01', to: '2026-03-31' });
    expect(mar.beginning).toEqual({ qty: 49, from: 2, to: 50 });
    expect(mar.receipts.qty).toBe(0);
    expect(mar.issued).toEqual({ qty: 2, from: 2, to: 3 });
    expect(mar.ending).toEqual({ qty: 47, from: 4, to: 50 });
    const feb = afAccountability({ begin: 1, end: 50 }, '2026-02-01', uses, { from: '2026-02-01', to: '2026-02-28' });
    expect(feb.beginning.qty).toBe(0);
    expect(feb.receipts).toEqual({ qty: 50, from: 1, to: 50 });
    expect(feb.ending.qty).toBe(49);
    expect(afAccountability({ begin: 1, end: 50 }, '2026-04-01', [], { from: '2026-03-01', to: '2026-03-31' }).ending.qty).toBe(0);
  });
});

describe('collections and RCD', () => {
  it('counts every OR except VOID/CANCELLED', () => {
    expect(isCollectionCounted('DRAFT')).toBe(true);
    expect(isCollectionCounted('ACCEPTED')).toBe(true);
    expect(isCollectionCounted('CANCELLED')).toBe(false);
    expect(isCollectionCounted('VOID')).toBe(false);
  });
  it('validates OR lines and sums them', () => {
    expect(collectionAmount([line('4-04-01-010', 5000), line('4-01-01-010', 2550)])).toBe(7550);
    expect(() => assertCollectionLines([])).toThrow(/at least one/);
    expect(() => assertCollectionLines([line('1-01-01-010', 100)])).toThrow(/cash account/);
    expect(() => assertCollectionLines([line('5-02-01-010', 100)])).toThrow(/not a receipt account/);
    expect(() => assertCollectionLines([line('4-04-01-010', 0)])).toThrow(/greater than zero/);
    expect(() => assertCollectionLines(Array.from({ length: 21 }, () => line('4-04-01-010', 1)))).toThrow(/at most 20/);
    expect(() => assertCollectionLines([line('2-03-01-010', 100), line('4-04-01-010', 1)])).not.toThrow();
  });
  it('breaks collections down by account and subsidiary', () => {
    const b = orBreakdownByAccount([{ lines: [line('4-04-01-010', 100), line('2-03-01-010', 50, 'X')] }, { lines: [line('4-04-01-010', 25)] }]);
    expect(b).toEqual([{ accountCode: '2-03-01-010', subsidiaryId: 'X', amount: 50 }, { accountCode: '4-04-01-010', subsidiaryId: null, amount: 125 }]);
  });
  it('carries the undeposited accountability forward', () => {
    expect(computeRcdTotals(0 as Centavos, [100, 200] as Centavos[], [300] as Centavos[], null).result).toBe('PASSED');
    const t = computeRcdTotals(0 as Centavos, [100, 200] as Centavos[], [100] as Centavos[], null);
    expect(t.result).toBe('FAILED');
    expect(t.undeposited).toBe(200);
    expect(computeRcdTotals(0 as Centavos, [300] as Centavos[], [100] as Centavos[], 'Collected after banking hours on the 31st').result).toBe('WARNING');
    // Last report's undeposited cash deposited this report is not "deposits exceed collections".
    expect(computeRcdTotals(200 as Centavos, [50] as Centavos[], [250] as Centavos[], null)).toMatchObject({ result: 'PASSED', undeposited: 0 });
    expect(computeRcdTotals(0 as Centavos, [50] as Centavos[], [250] as Centavos[], null).message).toMatch(/exceed/);
  });
  it('requires a deposit slip to equal its ORs', () => {
    expect(() => assertDepositMatches(500 as Centavos, 400 as Centavos)).toThrow(/exceed collections/);
    expect(() => assertDepositMatches(300 as Centavos, 400 as Centavos)).toThrow(/must equal/);
    expect(() => assertDepositMatches(400 as Centavos, 400 as Centavos)).not.toThrow();
  });
  it('registers the modules and reports', () => {
    expect(COLLECTIONS_MODULES.map((m) => m.key)).toEqual(['collection', 'deposit', 'rcd', 'rcr']);
    expect(COLLECTIONS_MODULES.find((m) => m.key === 'rcd')!.jevSource).toBe('RCD');
    for (const c of ['RCD', 'RCR', 'CASHBOOK', 'RAAF']) expect(reportBuilder(c)).toBeDefined();
  });
});
