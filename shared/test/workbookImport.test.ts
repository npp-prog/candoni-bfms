import { describe, expect, it } from 'vitest';
import {
  UNASSIGNED_SL,
  cellCentavos,
  cellDate,
  entriesByMonth,
  inferTransactionType,
  parseWorkbook,
  ppeDefaults,
  projectedBalances,
  tieOut,
} from '../src/accounting/workbookImport';
import { chunkEntries, openingPayload, toEntryPayload } from '../src/accounting/importPayload';

// Synthetic workbook only (fake names) — mirrors the legacy template's layout and quirks.
const D = (s: string) => new Date(`${s}T00:00:00Z`);
const HDR = ['Primary Reference', 'Account Code', 'SL', 'Account Name', 'P', 'Debit', 'Credit', 'JEV No', 'Name', 'Secondary Reference', 'Tertiary Reference', 'Date', 'Particulars', 'Transaction Type', 'Month'];
interface R { p?: string; a?: string; sl?: string; dr?: number; cr?: number; jev?: string; n?: string; s?: string; t?: string; d?: string | Date | null; part?: string; tt?: string; m?: string }
const row = (o: R) => [o.p ?? null, o.a ?? null, o.sl ?? null, null, null, o.dr ?? null, o.cr ?? null, o.jev ?? null, o.n ?? null, o.s ?? null, o.t ?? null, typeof o.d === 'string' && /^\d{4}-/.test(o.d) ? D(o.d) : (o.d ?? null), o.part ?? null, o.tt ?? null, o.m ?? null];

function workbook(cy: unknown[][], extra: Record<string, unknown[][]> = {}) {
  return {
    'Rep TB': [['Republic of the Philippines'], ['BARANGAY PAYAUAN']],
    ACODE: [
      ['Account Code', 'Account Name', 'Normal Balance', null, 'Active Codes', null, null, 'Month Codes', null, null, 'All SL Codes'],
      ['1-01-01-010', 'Cash - In Local Treasury', 'Debit', null, null, null, null, null, null, null, '1-01-01-010', 'BT01', 'ANA B. CRUZ'],
      ['1-01-02-010', 'Cash in Bank', 'Debit', null, null, null, null, null, null, null, '1-01-02-010', 'CIB01', 'TEST BANK'],
      ['1-03-03-020', 'Advances to Officers and Employees', 'Debit', null, null, null, null, null, null, null, '1-03-03-020', 'EO01', 'JOSE P. RIZAL'],
      ['2-02-01-010', 'Due to BIR', 'Credit', null, null, null, null, null, null, null, '2-02-01-010', 'BIR01', 'BIR'],
      ['9-99-99-999', 'Bogus', 'Debit'],
    ],
    'PY DB': [
      HDR,
      row({ a: '1-01-01-010', sl: 'BT01', dr: -100, d: '2025-01-01', part: 'Opening Balance' }),
      row({ a: '1-01-02-010', sl: 'CIB01', dr: 10000.1, d: '2025-01-01', part: 'Opening Balance' }),
      row({ a: '2-03-01-040', cr: 900, d: '2025-01-01', part: 'Opening Balance' }), // SL-controlled, no SL in workbook
      row({ a: '3-01-01-010', cr: 9000.1, d: '2025-01-01', part: 'Opening Balance' }),
    ],
    '01_CY DB': [HDR, ...cy],
    ...extra,
  };
}

describe('cell helpers', () => {
  it('rounds pesos half away from zero into centavos', () => {
    expect(cellCentavos(2528.57)).toBe(252857);
    expect(cellCentavos(1724.9599999999991)).toBe(172496);
    expect(cellCentavos(0.125)).toBe(13);
    expect(cellCentavos(-0.125)).toBe(-13);
    expect(cellCentavos('1,234.50')).toBe(123450);
    expect(cellCentavos(null)).toBe(0);
  });
  it('reads dates in the legacy forms', () => {
    expect(cellDate(D('2025-03-04')).date).toBe('2025-03-04');
    expect(cellDate(45658).date).toBe('2025-01-01');
    expect(cellDate('3/4/2025').date).toBe('2025-03-04');
    const typo = cellDate('12/202025');
    expect(typo.date).toBe('2025-12-20');
    expect(typo.note).toMatch(/Malformed/);
    expect(cellDate('soon').date).toBeNull();
  });
  it('PPE defaults follow the COA pairing', () => {
    expect(ppeDefaults('1-07-03-010')).toEqual({ accumulated: '1-07-03-011', expense: '5-04-01-020' });
    expect(ppeDefaults('1-07-06-010').expense).toBe('5-04-01-050');
    expect(ppeDefaults('1-07-99-990')).toEqual({ accumulated: '1-07-99-991', expense: '5-04-01-990' });
  });
  it('infers transaction types from the lines', () => {
    expect(inferTransactionType([{ accountCode: '1-01-02-010', debit: 1, credit: 0 }, { accountCode: '1-01-01-010', debit: 0, credit: 1 }])).toBe('DEPOSIT');
    expect(inferTransactionType([{ accountCode: '5-02-03-010', debit: 1, credit: 0 }, { accountCode: '1-01-02-010', debit: 0, credit: 1 }])).toBe('DISBURSEMENT');
    expect(inferTransactionType([{ accountCode: '1-01-01-010', debit: 1, credit: 0 }, { accountCode: '4-04-01-010', debit: 0, credit: 1 }])).toBe('COLLECTION');
    expect(inferTransactionType([{ accountCode: '5-02-99-990', debit: 1, credit: 0 }, { accountCode: '1-03-03-020', debit: 0, credit: 1 }])).toBe('LIQUIDATION');
  });
});

describe('parseWorkbook', () => {
  const cy = [
    row({ p: '500002', a: '5-02-03-010', dr: 1000, n: 'SHOP', s: '2025-02-002', d: '2025-02-10', part: 'Supplies', tt: 'Disbursement Voucher', m: '02' }),
    row({ p: '500002', a: '1-01-02-010', sl: 'CIB01', cr: 990, n: 'SHOP', s: '2025-02-002', d: '2025-02-10', part: 'Supplies', tt: 'Disbursement Voucher', m: '02' }),
    row({ p: '500002', a: '2-02-01-010', sl: 'BIR01', cr: 10, n: 'SHOP', s: '2025-02-002', d: '2025-02-10', part: 'Supplies', tt: 'Disbursement Voucher', m: '02' }),
    // same check/date/refs immediately followed by a different, already-balanced voucher
    row({ p: '500002', a: '5-02-04-020', dr: 50, n: 'POWER', s: '2025-02-002', d: '2025-02-10', part: 'Power', m: '03' }),
    row({ p: '500002', a: '1-01-02-010', sl: 'CIB01', cr: 50, n: 'POWER', s: '2025-02-002', d: '2025-02-10', part: 'Power', m: '03' }),
    row({ p: '500001', dr: 0, n: 'CANCELLED CHECK', t: 'N/A', d: '2025-01-05', part: 'Cancelled Check' }),
    row({ p: '500001', a: '1-01-02-010', sl: 'CIB01', cr: 0, n: 'CANCELLED CHECK', t: 'N/A', d: '2025-01-05', part: 'Cancelled Check' }),
    row({ p: '500003', a: '5-02-04-020', dr: 1000, n: 'POWER', s: '2025-03-001', d: '2025-03-05', part: 'Electricity' }),
    row({ p: '500003', a: '1-01-02-010', sl: 'CIB01', cr: 990, n: 'POWER', s: '2025-03-001', d: '2025-03-05', part: 'Electricity' }),
    // legacy-JEV-numbered entry whose debit and credit rows are far apart
    row({ p: '500004', a: '1-03-03-020', sl: 'EO01', dr: 300, jev: '07-2025-04-001', n: 'JOSE RIZAL', s: '2025-04-001', d: '2025-04-01', part: 'CA for travel' }),
    row({ p: 'BS', a: '1-01-02-010', sl: 'CIB01', dr: 5000, n: 'BRGY', s: 'BS', d: '2025-04-30', part: 'NTA' }),
    row({ p: 'BS', a: '1-01-02-010', sl: 'CIB01', dr: 5000, n: 'BRGY', s: 'BS', d: '2025-05-31', part: 'NTA' }),
    row({ p: 'BS', a: '4-01-04-010', sl: 'CIB01', cr: 5000, n: 'BRGY', s: 'BS', d: '2025-04-30', part: 'NTA' }),
    row({ p: 'BS', a: '4-01-04-010', sl: 'CIB01', cr: 5000, n: 'BRGY', s: 'BS', d: '2025-05-31', part: 'NTA' }),
    row({ p: '500004', a: '1-01-02-010', sl: 'CIB01', cr: 300, jev: '07-2025-04-001', n: 'JOSE RIZAL', s: '2025-04-001', d: '2025-04-01', part: 'CA for travel' }),
    // no date: DV month wins over the previous row
    row({ p: '500005', a: '5-02-99-990', dr: 20, n: 'X', s: '2025-06-007', part: 'Misc' }),
    row({ p: '500005', a: '1-01-02-010', sl: 'CIB01', cr: 20, n: 'X', s: '2025-06-007', part: 'Misc' }),
    row({ p: '500006', a: '5-02-99-990', dr: 20, n: 'X', s: '2025-06-008', d: '2026-06-01', part: 'Typo year' }),
    row({ p: '500006', a: '1-01-02-010', sl: 'CIB01', cr: 20, n: 'X', s: '2025-06-008', d: '2026-06-01', part: 'Typo year' }),
    row({ p: '500007', a: '1-01-02-010', sl: 'CIB99', dr: 20, n: 'X', d: '2025-07-01', part: 'Unknown SL' }),
    row({ p: '500007', a: '1-99-99-999', cr: 20, n: 'X', d: '2025-07-01', part: 'Unknown SL' }),
    row({ p: '500002', a: '5-02-99-990', dr: 5, n: 'DUP', s: '2025-08-001', d: '2025-08-01', part: 'Duplicate check' }),
    row({ p: '500002', a: '1-01-02-010', sl: 'CIB01', cr: 5, n: 'DUP', s: '2025-08-001', d: '2025-08-01', part: 'Duplicate check' }),
    [null, null, null, "Prior Years' Adjustments"],
  ];
  const w = parseWorkbook(
    workbook(cy, {
      '02.2_PRETB_3Y': [
        ['fff', 'Normal Balance', 'Account Name', '2025', '2025', '2024', '2024', '2023', '2023'],
        [null, null, null, 'Debit', 'Credit', 'Debit', 'Credit', 'Debit', 'Credit'],
        ['1-01-02-010', 'Debit', 'Cash in Bank', 14000, 0, 10000.1, 0, -50, 0],
        ['3-01-01-010', 'Credit', 'Equity', 0, 14000, 0, 10000.1, 0, -50],
      ],
      'Aging_Unliquidated CA': [
        ['BARANGAY PAYAUAN'],
        ['CHECK NO', 'DATE', 'DV NO', 'ACCOUNT NAME', 'AO', 'PARTICULARS', 'OLD CODE', 'NEW CODE', 'AMOUNT'],
        [111, D('2019-01-02'), '2019-01-001', 'ADVANCES TO OFFICERS & EMPLOYEES', 'Jose Rizal', 'Travel', 148, null, 1500],
        [112, D('2019-02-02'), null, null, 'JOSE P. RIZAL', 'Seminar', null, null, 500],
        [null, null, null, null, 'Sub Total', null, null, null, 2000],
        [113, D('2020-02-02'), null, 'Due from Officers and Employees', 'Unknown Person', 'Excess', 'N/A', '1-03-04-020', 75.5],
        [null, null, null, null, 'Grand total', null, null, null, 2075.5],
      ],
      'PPE Depr': [
        [null, null, null, 'years', 'Residual', 'Residual Amount', 'Depreciable Cost', 'Depreciation Expense'],
        ['1-07-03-010', 'Road Networks', 1000, 10, 0, 0, 1000, 100, null, '1-07-03-011', '5-04-01-020'],
        [],
        ['1-07-05-020', 'Office Equipment', 2000, 5, 0.05, 100, 1900, 380, null, '1-07-05-041', '5-04-01-040'],
        ['1-07-06-010', 'Motor Vehicles', 3000, 10, 0, 0, 3000, 300],
      ],
    }),
  );
  const issue = (code: string) => w.issues.filter((i) => i.code === code);

  it('guesses barangay and fiscal year', () => {
    expect(w.barangayGuess).toBe('PAYAUAN');
    expect(w.fiscalYear).toBe(2025);
  });

  it('reads the SL master and flags ACODE accounts unknown to BFMS', () => {
    expect(w.subsidiaries.filter((s) => s.source === 'ACODE').map((s) => s.subsidiaryCode)).toEqual(['BT01', 'CIB01', 'EO01', 'BIR01']);
    expect(w.subsidiaries.find((s) => s.subsidiaryCode === 'CIB01')!.type).toBe('BANK');
    expect(w.subsidiaries.find((s) => s.subsidiaryCode === 'BIR01')!.type).toBe('BIR');
    expect(w.subsidiaries.find((s) => s.subsidiaryCode === 'EO01')!.type).toBe('CASH_ADVANCE');
    expect(issue('UNKNOWN_ACCOUNT').some((i) => i.sheet === 'ACODE')).toBe(true);
  });

  it('builds a balanced opening entry (negative debit → credit, missing SL → UNASSIGNED)', () => {
    const o = w.opening!;
    expect(o.balanced).toBe(true);
    expect(o.hasError).toBe(false);
    expect(o.totalDebit).toBe(1000010);
    expect(o.lines.find((l) => l.accountCode === '1-01-01-010')).toMatchObject({ debit: 0, credit: 10000 });
    expect(o.lines.find((l) => l.accountCode === '2-03-01-040')!.subsidiaryCode).toBe(UNASSIGNED_SL);
    expect(issue('SL_DEFAULTED')).toHaveLength(1);
    expect(openingPayload(o, 2025)).toMatchObject({ key: 'OPENING', date: '2025-01-01', transactionType: 'OPENING' });
  });

  it('groups rows into entries and reports problems', () => {
    const byPart = (p: string) => w.entries.filter((e) => e.particulars === p);
    expect(byPart('Supplies')[0]).toMatchObject({ balanced: true, transactionType: 'DISBURSEMENT', transactionTypeInferred: false, primaryReference: '500002', secondaryReference: '2025-02-002', payeeName: 'SHOP' });
    expect(byPart('Supplies')[0]!.lines).toHaveLength(3);
    expect(byPart('Power')[0]!.balanced).toBe(true); // split from Supplies although key is the same
    expect(issue('MONTH_MISMATCH').some((i) => i.entryKey === byPart('Power')[0]!.key)).toBe(true);
    const elec = byPart('Electricity')[0]!;
    expect(elec).toMatchObject({ balanced: false, difference: 1000, hasError: true });
    expect(issue('UNBALANCED').find((i) => i.entryKey === elec.key)!.message).toMatch(/difference 10\.00/);
    const ca = byPart('CA for travel')[0]!;
    expect(ca).toMatchObject({ balanced: true, legacyJevNo: '07-2025-04-001', hasError: false });
    expect(toEntryPayload(ca).tertiaryReference).toBe('07-2025-04-001');
    const nta = byPart('NTA');
    expect(nta).toHaveLength(2);
    expect(nta.every((e) => e.balanced && !e.hasError && e.lines.every((l) => l.accountCode !== '4-01-04-010' || l.subsidiaryCode === null))).toBe(true);
    expect(issue('MERGED_ROWS')).toHaveLength(2);
    expect(issue('SL_DROPPED').length).toBeGreaterThan(0);
    expect(byPart('Misc')[0]).toMatchObject({ date: '2025-06-01', dateInferred: true, hasError: false });
    expect(byPart('Typo year')[0]!.hasError).toBe(true);
    expect(issue('OUTSIDE_YEAR')).toHaveLength(1);
    const unk = byPart('Unknown SL')[0]!;
    expect(unk.hasError).toBe(true);
    expect(issue('UNKNOWN_ACCOUNT').some((i) => i.entryKey === unk.key)).toBe(true);
    expect(w.subsidiaries.some((s) => s.subsidiaryCode === 'CIB99' && s.source === 'JOURNAL')).toBe(true);
    expect(issue('DUPLICATE_CHECK').length).toBeGreaterThanOrEqual(2);
    expect(w.cancelledChecks).toEqual([{ checkNumber: '500001', date: '2025-01-05', dvNumber: null, payeeName: null, rows: [7, 8] }]);
    // date order
    const dates = w.entries.map((e) => e.date ?? '9999');
    expect([...dates].sort()).toEqual(dates);
    expect(entriesByMonth(w.entries).find((m) => m.month === '2025-03')).toMatchObject({ entries: 1, errors: 1 });
  });

  it('reads prior-year TBs and ties the import out against the workbook TB', () => {
    expect(w.priorYears.map((y) => y.fiscalYear)).toEqual([2024, 2023]);
    expect(w.priorYears[0]!.rows).toEqual([
      { accountCode: '1-01-02-010', debit: 1000010, credit: 0 },
      { accountCode: '3-01-01-010', debit: 0, credit: 1000010 },
    ]);
    expect(w.priorYears[1]!.rows[0]).toEqual({ accountCode: '1-01-02-010', debit: 0, credit: 5000 });
    const bal = projectedBalances(w);
    expect(bal.get('1-01-02-010')).toBe(1000010 - 99000 - 5000 - 30000 + 1000000 - 2000 - 500);
    expect(tieOut(w).some((x) => x.accountCode === '1-01-02-010')).toBe(true);
  });

  it('reads the legacy CA list with section accounts and officer SL matching', () => {
    expect(w.legacyCashAdvances).toHaveLength(3);
    expect(w.legacyCashAdvances[0]).toMatchObject({ accountCode: '1-03-03-020', subsidiaryCode: 'EO01', checkNumber: '111', dvNumber: '2019-01-001', amount: 150000 });
    expect(w.legacyCashAdvances[1]).toMatchObject({ accountCode: '1-03-03-020', subsidiaryCode: 'EO01', amount: 50000 });
    expect(w.legacyCashAdvances[2]).toMatchObject({ accountCode: '1-03-04-020', subsidiaryCode: null, amount: 7550 });
  });

  it('reads the last PPE block with defaults and warnings', () => {
    expect(w.ppeSchedule.map((r) => r.accountCode)).toEqual(['1-07-05-020', '1-07-06-010']);
    expect(w.ppeSchedule[0]).toMatchObject({ residualRateBp: 500, usefulLifeYears: 5, accumulatedAccountCode: '1-07-05-021', expenseAccountCode: '5-04-01-040', costOverride: null, workbookCost: 200000 });
    expect(w.ppeSchedule[1]).toMatchObject({ residualRateBp: 0, usefulLifeYears: 10, expenseAccountCode: '5-04-01-050' });
    expect(issue('PPE_CODE').some((i) => /1-07-05-041/.test(i.message))).toBe(true);
  });

  it('chunks entries within the call limits, keeping order', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ key: `k${i}`, lines: [1, 2] }));
    const chunks = chunkEntries(many);
    expect(chunks.flat().map((x) => x.key)).toEqual(many.map((x) => x.key));
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(120);
  });

  it('rejects entries with no date when inference is off', () => {
    const w2 = parseWorkbook(workbook([row({ p: '1', a: '5-02-99-990', dr: 1, s: 'x', part: 'No date' }), row({ p: '1', a: '1-01-02-010', sl: 'CIB01', cr: 1, s: 'x', part: 'No date' })]), { inferMissingDates: false });
    expect(w2.entries[0]!.hasError).toBe(true);
    expect(w2.issues.some((i) => i.code === 'MISSING_DATE' && i.severity === 'ERROR')).toBe(true);
  });
});
