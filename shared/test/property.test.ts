import { describe, expect, it } from 'vitest';
import {
  BfmsError,
  CAPITALIZATION_THRESHOLD,
  PROPERTY_MODULES,
  addYearMonths,
  applyBioMovement,
  defaultResidualValue,
  depreciationFor,
  depreciationStartPeriod,
  formatPropertyNumber,
  hasDepreciationGap,
  isCapitalizable,
  ppeAccountsFor,
  ppeGroupCode,
  reportBuilder,
  stockAfterIssue,
  stockAfterReceipt,
  stockCardBalances,
  type Centavos,
} from '../src';
import { pesosInWords } from '../src/reports/builders/property';

const c = (n: number) => n as Centavos;

describe('PPE accounts and numbering', () => {
  it('derives contra and expense accounts from the PPE account', () => {
    expect(ppeAccountsFor('1-07-05-020')).toEqual({ accumulatedDepreciationAccountCode: '1-07-05-021', depreciationExpenseAccountCode: '5-04-01-040', depreciable: true });
    expect(ppeAccountsFor('1-07-06-010').depreciationExpenseAccountCode).toBe('5-04-01-050');
    expect(ppeAccountsFor('1-07-99-990').accumulatedDepreciationAccountCode).toBe('1-07-99-991');
    expect(ppeAccountsFor('1-07-01-010').depreciable).toBe(false); // land
    expect(ppeAccountsFor('1-07-10-030').depreciable).toBe(false); // construction in progress
    expect(() => ppeAccountsFor('1-04-03-010')).toThrow(BfmsError);
  });
  it('formats property numbers YYYY-{PPEcode}-NNNN', () => {
    expect(ppeGroupCode('1-07-05-020')).toBe('05-020');
    expect(formatPropertyNumber(2026, '1-07-05-020', 3)).toBe('2026-05-020-0003');
  });
  it('applies the ₱50,000 capitalization threshold and 5% residual', () => {
    expect(CAPITALIZATION_THRESHOLD).toBe(5_000_000);
    expect(isCapitalizable(c(4_999_999))).toBe(false);
    expect(isCapitalizable(c(5_000_000))).toBe(true);
    expect(defaultResidualValue(c(6_500_000))).toBe(325_000);
  });
});

describe('depreciation', () => {
  const asset = { acquisitionCost: c(6_000_000), residualValue: c(300_000), usefulLifeYears: 5, depreciationStartPeriod: '2026-03', lastDepreciatedPeriod: null, accumulatedDepreciation: c(0) };
  it('starts in the month for the 1st–15th, else the next month', () => {
    expect(depreciationStartPeriod('2026-03-15')).toBe('2026-03');
    expect(depreciationStartPeriod('2026-03-16')).toBe('2026-04');
    expect(depreciationStartPeriod('2026-12-20')).toBe('2027-01');
    expect(addYearMonths('2026-01', -1)).toBe('2025-12');
  });
  it('computes straight-line monthly depreciation and is idempotent per month', () => {
    expect(depreciationFor(asset, '2026-02')).toBe(0);
    expect(depreciationFor(asset, '2026-03')).toBe(95_000); // (60,000 − 3,000) / 60
    expect(depreciationFor({ ...asset, lastDepreciatedPeriod: '2026-03', accumulatedDepreciation: c(95_000) }, '2026-03')).toBe(0);
    expect(depreciationFor({ ...asset, accumulatedDepreciation: c(5_650_000) }, '2026-04')).toBe(50_000); // capped at depreciable amount
  });
  it('detects a skipped month', () => {
    expect(hasDepreciationGap(asset, '2026-03')).toBe(false);
    expect(hasDepreciationGap(asset, '2026-04')).toBe(true);
    expect(hasDepreciationGap({ ...asset, lastDepreciatedPeriod: '2026-03' }, '2026-04')).toBe(false);
  });
});

describe('moving-average stock', () => {
  it('averages receipts and refuses over-issue', () => {
    let s = stockAfterReceipt({ quantityOnHand: 0, unitCost: c(0) }, 10, c(1_000));
    s = stockAfterReceipt(s, 10, c(2_000));
    expect(s).toEqual({ quantityOnHand: 20, unitCost: 1_500 });
    const i = stockAfterIssue(s, 5);
    expect(i.quantityOnHand).toBe(15);
    expect(i.issueCost).toBe(7_500);
    expect(() => stockAfterIssue(i, 16)).toThrow(/only 15 on hand/);
  });
  it('builds stock-card balances in date/sequence order', () => {
    const rows = stockCardBalances([
      { date: '2026-03-10', seq: 2, quantity: -3, unitCost: 100 },
      { date: '2026-03-01', seq: 1, quantity: 10, unitCost: 100 },
    ]);
    expect(rows.map((r) => r.balance)).toEqual([10, 7]);
  });
});

describe('biological assets', () => {
  it('rolls quantities and carrying amounts', () => {
    let s = applyBioMovement({ quantityOnHand: 4, carryingAmount: c(400_000) }, 'BIRTH', 2, 100_000);
    expect(s).toMatchObject({ quantityOnHand: 6, carryingAmount: 500_000 });
    s = applyBioMovement(s, 'DEATH', 1);
    expect(s.amount).toBe(83_333);
    expect(() => applyBioMovement(s, 'DISPOSITION', 9)).toThrow(BfmsError);
  });
});

describe('property module wiring', () => {
  it('registers modules with unique keys and builders for every property report', () => {
    expect(new Set(PROPERTY_MODULES.map((m) => m.key)).size).toBe(PROPERTY_MODULES.length);
    for (const code of ['PR', 'PO', 'AIR', 'ARDSM', 'RIS', 'ICS', 'PAR', 'RRPE', 'STOCK_CARD', 'PEC', 'PELC', 'BAPC', 'QRBA', 'RSMI', 'RPCI', 'RPCPPE', 'IIRUP', 'PPE_DEPRECIATION']) expect(reportBuilder(code), code).toBeTruthy();
  });
  it('writes amounts in words for the PO', () => {
    expect(pesosInWords(12_345_67)).toBe('Twelve Thousand Three Hundred Forty-Five Pesos and 67/100');
    expect(pesosInWords(100)).toBe('One Peso Only');
  });
});
