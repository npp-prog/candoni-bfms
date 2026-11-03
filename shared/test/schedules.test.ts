import { describe, expect, it } from 'vitest';
import {
  accumulatedDepreciationCode,
  buildCaSchedule,
  computePpeSchedule,
  creditNamesAdvance,
  defaultPpeRow,
  depreciationJevLines,
  depreciationRunId,
  isCaScheduleAccount,
  isDepreciablePpeAccount,
  mergePpeRows,
  ppeAccountsWithBalance,
  ppeDefaults,
  ppeGlFigures,
  type CaLedgerLine,
  type CaLegacyItem,
  type PpeBalanceRow,
} from '../src/accounting/schedules';
import type { Centavos } from '../src/types/common';

const c = (pesos: number) => Math.round(pesos * 100) as Centavos;
const AO = 'HABA_1-03-03-020_AO01';
let n = 0;
function line(p: Partial<CaLedgerLine> & Pick<CaLedgerLine, 'jevDate'>): CaLedgerLine {
  n++;
  return {
    jevId: `J${n}`,
    jevNumber: `2026-01-${String(n).padStart(3, '0')}`,
    entryType: 'REGULAR',
    accountCode: '1-03-03-020',
    subsidiaryId: AO,
    debit: 0 as Centavos,
    credit: 0 as Centavos,
    primaryReference: null,
    secondaryReference: null,
    lineDescription: '',
    particulars: '',
    payeeName: null,
    ...p,
  };
}
const legacy = (p: Partial<CaLegacyItem> & Pick<CaLegacyItem, 'id' | 'date' | 'amount'>): CaLegacyItem => ({
  accountCode: '1-03-03-020',
  subsidiaryId: AO,
  officerName: 'Officer One',
  checkNumber: null,
  dvNumber: null,
  particulars: 'legacy advance',
  ...p,
});
const officers = new Map([[AO, { name: 'Officer One', code: 'AO01' }]]);

describe('CA schedule accounts', () => {
  it('covers advances and due from officers', () => {
    expect(isCaScheduleAccount('1-03-03-010')).toBe(true);
    expect(isCaScheduleAccount('1-03-03-020')).toBe(true);
    expect(isCaScheduleAccount('1-03-04-020')).toBe(true);
    expect(isCaScheduleAccount('1-03-04-990')).toBe(false);
    expect(isCaScheduleAccount('1-03-01-010')).toBe(false);
  });
  it('matches check / DV numbers as whole words', () => {
    expect(creditNamesAdvance('Liquidation of Chk 1218491', { checkNumber: '1218491', dvNumber: null })).toBe(true);
    expect(creditNamesAdvance('LR for DV 2026-03-001', { checkNumber: null, dvNumber: '2026-03-001' })).toBe(true);
    expect(creditNamesAdvance('Chk 12184910', { checkNumber: '1218491', dvNumber: null })).toBe(false);
    expect(creditNamesAdvance('anything', { checkNumber: '12', dvNumber: null })).toBe(false);
  });
});

describe('buildCaSchedule', () => {
  const advances = [
    line({ jevDate: '2026-01-10', debit: c(10000), primaryReference: '0000101', secondaryReference: '2026-01-001', particulars: 'CA honoraria' }),
    line({ jevDate: '2026-02-10', debit: c(5000), primaryReference: '0000102', secondaryReference: '2026-02-001', particulars: 'CA travel' }),
  ];

  it('applies credits FIFO to the oldest advance', () => {
    const s = buildCaSchedule({ fiscalYear: 2026, asOf: '2026-03-31', legacy: [], officers, lines: [...advances, line({ jevDate: '2026-03-01', credit: c(12000), particulars: 'Liquidation' })] });
    const sl = s.sls[0]!;
    expect(sl.items.map((i) => i.outstanding)).toEqual([0, c(3000)]);
    expect(s.officers[0]!.items).toHaveLength(1);
    expect(s.grandTotal).toBe(c(3000));
    expect(sl.ledgerBalance).toBe(c(3000));
    expect(s.reconciled).toBe(true);
  });

  it('applies a credit to the advance named in its reference first, then FIFO', () => {
    const s = buildCaSchedule({
      fiscalYear: 2026,
      asOf: '2026-03-31',
      legacy: [],
      officers,
      lines: [...advances, line({ jevDate: '2026-03-01', credit: c(6000), primaryReference: 'LR 2026-03-01', lineDescription: 'Liquidation of DV 2026-02-001' })],
    });
    const [a1, a2] = s.sls[0]!.items;
    expect(a2!.outstanding).toBe(0);
    expect(a2!.applications[0]!.targeted).toBe(true);
    expect(a1!.outstanding).toBe(c(9000)); // the 1,000 remainder went FIFO
    expect(s.sls[0]!.credits[0]!.targeted).toBe(c(5000));
  });

  it('lists over-liquidation as a negative unapplied credit and still reconciles', () => {
    const s = buildCaSchedule({ fiscalYear: 2026, asOf: '2026-03-31', legacy: [], officers, lines: [...advances, line({ jevDate: '2026-03-01', credit: c(16000) })] });
    const sl = s.sls[0]!;
    expect(sl.scheduleBalance).toBe(-c(1000));
    expect(sl.ledgerBalance).toBe(-c(1000));
    expect(sl.items.find((i) => i.source === 'UNAPPLIED_CREDIT')!.outstanding).toBe(-c(1000));
    expect(s.grandTotal).toBe(-c(1000));
    expect(s.reconciled).toBe(true);
  });

  it('ages outstanding advances into buckets', () => {
    const s = buildCaSchedule({
      fiscalYear: 2026,
      asOf: '2026-12-31',
      officers,
      legacy: [legacy({ id: 'L1', date: '2024-06-14', amount: c(500) }), legacy({ id: 'L2', date: '2026-03-01', amount: c(700) })],
      lines: [line({ jevDate: '2026-01-01', entryType: 'OPENING', debit: c(1200) }), line({ jevDate: '2026-12-15', debit: c(300) })],
    });
    const items = s.officers[0]!.items;
    expect(items.map((i) => i.bucket)).toEqual(['Over 1 year', '181-365 days', '0-30 days']);
    expect(items[0]!.days).toBe(930);
    expect(s.bucketTotals[0]).toBe(c(300));
    expect(s.bucketTotals[5]).toBe(c(500));
    expect(s.grandTotal).toBe(c(1500));
    expect(s.reconciled).toBe(true);
  });

  it('flags a difference between legacy detail and the opening SL balance', () => {
    const s = buildCaSchedule({
      fiscalYear: 2026,
      asOf: '2026-12-31',
      officers,
      legacy: [legacy({ id: 'L1', date: '2024-06-14', amount: c(500) })],
      lines: [line({ jevDate: '2026-01-01', entryType: 'OPENING', debit: c(800) })],
    });
    expect(s.reconciled).toBe(false);
    expect(s.differences[0]!.difference).toBe(-c(300));
  });

  it('lists an opening balance without legacy detail as balance forward', () => {
    const s = buildCaSchedule({ fiscalYear: 2026, asOf: '2026-06-30', officers, legacy: [], lines: [line({ jevDate: '2026-01-01', entryType: 'OPENING', debit: c(800) }), line({ jevDate: '2026-02-01', credit: c(300) })] });
    const it0 = s.sls[0]!.items[0]!;
    expect(it0.source).toBe('BALANCE_FORWARD');
    expect(it0.outstanding).toBe(c(500));
    expect(s.reconciled).toBe(true);
  });

  it('keeps a negative legacy item (over-liquidated) out of credit application', () => {
    const s = buildCaSchedule({
      fiscalYear: 2026,
      asOf: '2026-06-30',
      officers,
      legacy: [legacy({ id: 'L1', date: '2018-07-26', amount: -c(32) }), legacy({ id: 'L2', date: '2019-01-23', amount: c(1000) })],
      lines: [line({ jevDate: '2026-01-01', entryType: 'OPENING', debit: c(968) }), line({ jevDate: '2026-02-01', credit: c(400) })],
    });
    expect(s.sls[0]!.items.map((i) => i.outstanding)).toEqual([-c(32), c(600)]);
    expect(s.reconciled).toBe(true);
  });

  it('ignores lines after the as-of date', () => {
    const s = buildCaSchedule({ fiscalYear: 2026, asOf: '2026-01-31', legacy: [], officers, lines: advances });
    expect(s.grandTotal).toBe(c(10000));
  });
});

describe('PPE schedule', () => {
  it('defaults by account group (legacy rates and lives)', () => {
    expect(ppeDefaults('1-07-03-010')).toMatchObject({ residualRateBp: 0, usefulLifeYears: 10, accumulatedAccountCode: '1-07-03-011', expenseAccountCode: '5-04-01-020' });
    expect(ppeDefaults('1-07-04-990')).toMatchObject({ residualRateBp: 0, usefulLifeYears: 10, accumulatedAccountCode: '1-07-04-991', expenseAccountCode: '5-04-01-030' });
    expect(ppeDefaults('1-07-05-020')).toMatchObject({ residualRateBp: 500, usefulLifeYears: 5, expenseAccountCode: '5-04-01-040' });
    expect(ppeDefaults('1-07-06-010')).toMatchObject({ expenseAccountCode: '5-04-01-050', accumulatedAccountCode: '1-07-06-011' });
    expect(ppeDefaults('1-07-07-020')).toMatchObject({ expenseAccountCode: '5-04-01-060' });
    expect(ppeDefaults('1-07-99-990')).toMatchObject({ expenseAccountCode: '5-04-01-990', accumulatedAccountCode: '1-07-99-991' });
    expect(accumulatedDepreciationCode('1-07-05-990')).toBe('1-07-05-991');
    expect(isDepreciablePpeAccount('1-07-01-010')).toBe(false);
    expect(isDepreciablePpeAccount('1-07-10-030')).toBe(false);
    expect(isDepreciablePpeAccount('1-07-05-021')).toBe(false);
    expect(isDepreciablePpeAccount('1-07-05-022')).toBe(false);
    expect(isDepreciablePpeAccount('1-07-05-020')).toBe(true);
  });

  it('computes residual, depreciable amount and annual depreciation like the legacy sheet', () => {
    const rows = [defaultPpeRow('1-07-05-020'), defaultPpeRow('1-07-04-010')];
    const gl = new Map([
      ['1-07-05-020', { cost: c(57075), accumulatedBefore: 0 as Centavos, accumulatedEnd: 0 as Centavos }],
      ['1-07-04-010', { cost: c(600000), accumulatedBefore: 0 as Centavos, accumulatedEnd: 0 as Centavos }],
    ]);
    const [eq, bldg] = computePpeSchedule(rows, gl);
    expect(eq!.residualValue).toBe(c(2853.75));
    expect(eq!.depreciableAmount).toBe(c(54221.25));
    expect(eq!.annualDepreciation).toBe(c(10844.25));
    expect(eq!.monthlyDepreciation).toBe(Math.round(c(54221.25) / 60));
    expect(bldg!.residualValue).toBe(0);
    expect(bldg!.periodDepreciation).toBe(c(60000));
  });

  it('uses the cost override and caps at the remaining depreciable amount', () => {
    const row = { ...defaultPpeRow('1-07-06-010'), costOverride: c(850000) };
    const gl = new Map([['1-07-06-010', { cost: c(900000), accumulatedBefore: c(750000), accumulatedEnd: c(750000) }]]);
    const [r] = computePpeSchedule([row], gl);
    expect(r!.cost).toBe(c(850000));
    expect(r!.depreciableAmount).toBe(c(807500));
    expect(r!.annualDepreciation).toBe(c(161500));
    expect(r!.periodDepreciation).toBe(c(57500));
    expect(r!.capped).toBe(true);
    expect(r!.netBookValue).toBe(c(100000));
    const [m] = computePpeSchedule([row], new Map([['1-07-06-010', { cost: c(850000), accumulatedBefore: c(807500), accumulatedEnd: c(807500) }]]), 'MONTH');
    expect(m!.periodDepreciation).toBe(0);
  });

  it('consolidates the JEV by expense and accumulated depreciation account', () => {
    const rows = ['1-07-03-010', '1-07-03-050', '1-07-05-020', '1-07-05-040'].map(defaultPpeRow);
    const gl = new Map(rows.map((r, i) => [r.accountCode, { cost: c([93750, 188000, 57075, 75841.16][i]!), accumulatedBefore: 0 as Centavos, accumulatedEnd: 0 as Centavos }]));
    const lines = depreciationJevLines(computePpeSchedule(rows, gl));
    expect(lines).toEqual([
      { accountCode: '5-04-01-020', debit: c(9375 + 18800), credit: 0 },
      { accountCode: '5-04-01-040', debit: c(10844.25) + c(14409.82), credit: 0 },
      { accountCode: '1-07-03-011', debit: 0, credit: c(9375) },
      { accountCode: '1-07-03-051', debit: 0, credit: c(18800) },
      { accountCode: '1-07-05-021', debit: 0, credit: c(10844.25) },
      { accountCode: '1-07-05-041', debit: 0, credit: c(14409.82) },
    ]);
    expect(lines.reduce((t, l) => t + l.debit - l.credit, 0)).toBe(0);
  });

  it('reads GL figures from period movements and merges defaults', () => {
    const b: PpeBalanceRow[] = [
      { month: 0, accountCode: '1-07-05-020', subsidiaryId: null, debit: c(200000), credit: 0 as Centavos },
      { month: 0, accountCode: '1-07-05-021', subsidiaryId: null, debit: 0 as Centavos, credit: c(40000) },
      { month: 3, accountCode: '1-07-05-030', subsidiaryId: null, debit: c(40000), credit: 0 as Centavos },
      { month: 12, accountCode: '1-07-05-021', subsidiaryId: null, debit: 0 as Centavos, credit: c(38000) },
      { month: 0, accountCode: '1-07-01-010', subsidiaryId: null, debit: c(1), credit: 0 as Centavos },
    ];
    expect(ppeAccountsWithBalance(b)).toEqual(['1-07-05-020', '1-07-05-030']);
    expect(ppeAccountsWithBalance(b, 2)).toEqual(['1-07-05-020']);
    const rows = mergePpeRows([{ ...defaultPpeRow('1-07-05-020'), usefulLifeYears: 10 }], ppeAccountsWithBalance(b));
    expect(rows.map((r) => [r.accountCode, r.usefulLifeYears])).toEqual([['1-07-05-020', 10], ['1-07-05-030', 5]]);
    const gl = ppeGlFigures(rows, b, { costMonth: 12, fromMonth: 1, toMonth: 12 });
    expect(gl.get('1-07-05-020')).toEqual({ cost: c(200000), accumulatedBefore: c(40000), accumulatedEnd: c(78000) });
    expect(depreciationRunId('HABA', 2026, null)).toBe('HABA_2026_YR');
    expect(depreciationRunId('HABA', 2026, 3)).toBe('HABA_2026_03');
  });
});
