import { describe, expect, it } from 'vitest';
import {
  BfmsError,
  DV_MODULE,
  PAYROLL_MAX_ENTRIES,
  aggregatePayrollDeductions,
  computeDvTotals,
  computePayroll,
  dvAddDays,
  dvJournalLines,
  dvLiquidationDueDate,
  dvRequiresObligation,
  payrollDeductionColumns,
  reportBuilder,
  runReport,
  transitionsFrom,
  type DataSource,
  type Filter,
} from '../src/index';

describe('DV arithmetic', () => {
  it('computes gross, taxes (rate × base) and net', () => {
    const t = computeDvTotals({
      charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 1_000_000 }, { accountCode: '5-02-99-990', subsidiaryId: null, amount: 120_000 }],
      taxes: [{ taxType: 'EWT', rateBp: 100 }, { taxType: 'VAT', rateBp: 500, base: 1_000_000 }],
      otherDeductions: [{ description: 'Penalty', accountCode: '4-02-02-990', subsidiaryId: null, amount: 5_000 }],
    });
    expect(t.grossAmount).toBe(1_120_000);
    expect(t.taxDeductions.map((x) => x.amount)).toEqual([11_200, 50_000]);
    expect(t.totalTaxes).toBe(61_200);
    expect(t.netAmount).toBe(1_120_000 - 61_200 - 5_000);
  });
  it('rounds tax half away from zero', () => {
    // 1% of ₱10.50 = ₱0.105 → ₱0.11
    expect(computeDvTotals({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 1050 }], taxes: [{ taxType: 'EWT', rateBp: 100 }], otherDeductions: [] }).totalTaxes).toBe(11);
  });
  it('rejects empty, zero, over-deducted and over-based vouchers', () => {
    expect(() => computeDvTotals({ charges: [], taxes: [], otherDeductions: [] })).toThrow(BfmsError);
    expect(() => computeDvTotals({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 0 }], taxes: [], otherDeductions: [] })).toThrow(/greater than zero/);
    expect(() => computeDvTotals({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 100 }], taxes: [], otherDeductions: [{ description: 'x', accountCode: '2-02-01-020', subsidiaryId: null, amount: 100 }] })).toThrow(/net amount/);
    expect(() => computeDvTotals({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 100 }], taxes: [{ taxType: 'EWT', rateBp: 100, base: 200 }], otherDeductions: [] })).toThrow(/taxable base/);
    expect(() => computeDvTotals({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 10.5 }], taxes: [], otherDeductions: [] })).toThrow();
  });
  it('knows which charges need an obligation', () => {
    expect(dvRequiresObligation('5-02-03-010')).toBe(true);
    expect(dvRequiresObligation('1-07-05-020')).toBe(true);
    expect(dvRequiresObligation('2-02-01-010')).toBe(false);
    expect(dvRequiresObligation('1-03-03-020')).toBe(false);
  });
});

describe('DV journal template', () => {
  it('Dr charges / Cr BIR, deductions and cash — balanced', () => {
    const t = computeDvTotals({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 1_000_000 }], taxes: [{ taxType: 'EWT', rateBp: 100 }], otherDeductions: [{ description: 'GSIS', accountCode: '2-02-01-020', subsidiaryId: 'AGBOY_2-02-01-020_GSIS01', amount: 20_000 }] });
    const lines = dvJournalLines({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 1_000_000 }], taxDeductions: t.taxDeductions, otherDeductions: [{ description: 'GSIS', accountCode: '2-02-01-020', subsidiaryId: 'AGBOY_2-02-01-020_GSIS01', amount: 20_000 }], netAmount: t.netAmount, taxSubsidiaryId: 'AGBOY_2-02-01-010_BIR01' }, { accountCode: '1-01-02-010', subsidiaryId: 'AGBOY_1-01-02-010_CIB01' });
    expect(lines).toEqual([
      { accountCode: '5-02-03-010', subsidiaryId: null, debit: 1_000_000, credit: 0, lineDescription: '' },
      { accountCode: '2-02-01-010', subsidiaryId: 'AGBOY_2-02-01-010_BIR01', debit: 0, credit: 10_000, lineDescription: 'EWT withheld' },
      { accountCode: '2-02-01-020', subsidiaryId: 'AGBOY_2-02-01-020_GSIS01', debit: 0, credit: 20_000, lineDescription: 'GSIS' },
      { accountCode: '1-01-02-010', subsidiaryId: 'AGBOY_1-01-02-010_CIB01', debit: 0, credit: 970_000, lineDescription: '' },
    ]);
  });
  it('refuses a tampered net amount', () => {
    expect(() => dvJournalLines({ charges: [{ accountCode: '5-02-03-010', subsidiaryId: null, amount: 100 }], taxDeductions: [], otherDeductions: [], netAmount: 99 }, { accountCode: '1-01-02-010', subsidiaryId: 'x' })).toThrow(/does not balance/);
  });
});

describe('cash advance due dates', () => {
  it('adds the configured days per type', () => {
    expect(dvAddDays('2026-03-15', 30)).toBe('2026-04-14');
    expect(dvAddDays('2026-12-30', 5)).toBe('2027-01-04');
    expect(dvLiquidationDueDate('2026-03-26', 'PAYROLL')).toBe('2026-03-31');
    expect(dvLiquidationDueDate('2026-03-26', 'PAYROLL', { PAYROLL: 10 })).toBe('2026-04-05');
    expect(dvLiquidationDueDate('2026-02-01', 'OFFICIAL_TRAVEL', {})).toBe('2026-03-03');
  });
});

describe('payroll', () => {
  const entries = [
    { payeeName: 'A', position: 'PB', grossAmount: 1_200_000, deductions: [{ description: 'W/Tax', accountCode: '2-02-01-010', amount: 60_000 }, { description: 'Pag-IBIG', accountCode: '2-02-01-030', amount: 10_000 }] },
    { payeeName: 'B', position: 'Kagawad', grossAmount: 900_000, deductions: [{ description: 'W/Tax', accountCode: '2-02-01-010', amount: 45_000 }, { description: 'Zero', accountCode: '2-02-01-040', amount: 0 }] },
  ];
  it('recomputes nets and totals and drops zero deductions', () => {
    const p = computePayroll(entries);
    expect(p.entries.map((e) => e.netAmount)).toEqual([1_130_000, 855_000]);
    expect(p.entries[1]!.deductions).toHaveLength(1);
    expect([p.entryCount, p.grossAmount, p.totalDeductions, p.netAmount]).toEqual([2, 2_100_000, 115_000, 1_985_000]);
  });
  it('rejects deductions above gross and too many payees', () => {
    expect(() => computePayroll([{ payeeName: 'X', position: '', grossAmount: 100, deductions: [{ description: 'd', accountCode: '2-02-01-010', amount: 101 }] }])).toThrow(/exceed/);
    expect(() => computePayroll(Array.from({ length: PAYROLL_MAX_ENTRIES + 1 }, () => ({ payeeName: 'X', position: '', grossAmount: 1, deductions: [] })))).toThrow(/at most/);
  });
  it('builds deduction columns and per-account DV deductions', () => {
    const p = computePayroll(entries);
    expect(payrollDeductionColumns(p.entries).map((c) => c.description)).toEqual(['W/Tax', 'Pag-IBIG']);
    expect(aggregatePayrollDeductions(p.entries)).toEqual([
      { description: 'W/Tax', accountCode: '2-02-01-010', amount: 105_000 },
      { description: 'Pag-IBIG', accountCode: '2-02-01-030', amount: 10_000 },
    ]);
  });
});

describe('DV workflow definition', () => {
  it('pays only approved vouchers and accepts after approval', () => {
    const acts = (s: string) => transitionsFrom(DV_MODULE, s).map((t) => t.action);
    expect(acts('APPROVED')).toEqual(expect.arrayContaining(['ISSUE_CHECK', 'ISSUE_ADA', 'RELEASE', 'CANCEL_PAYMENT', 'ACCEPT', 'RETURN', 'VOID']));
    expect(acts('SUBMITTED')).not.toContain('ISSUE_CHECK');
    expect(DV_MODULE.transitions.find((t) => t.action === 'APPROVE')?.segregation).toBe(true);
    expect(DV_MODULE.jevSource).toBe('DV');
  });
});

/** In-memory DataSource for builder tests (supports '==' filters only). */
function memoryDs(data: Record<string, Array<Record<string, unknown>>>): DataSource {
  const match = (r: Record<string, unknown>, f: readonly Filter[]) => f.every(([k, , v]) => r[k] === v);
  return {
    async get(c, id) { return ((data[c] ?? []).find((r) => r.id === id) ?? null) as never; },
    async list(c, f) { return (data[c] ?? []).filter((r) => match(r, f)) as never; },
    async listGroup() { return []; },
    async listSub() { return []; },
  };
}

describe('Report of Checks Issued / Cancelled Checks', () => {
  const chk = (n: string, date: string, amount: number, status = 'ISSUED', extra = {}) => ({ id: n, barangayId: 'AGBOY', fiscalYear: 2026, bankAccountId: 'B1', checkNumber: n, checkDate: date, payee: { id: null, name: `Payee ${n}` }, dvId: 'd', dvNumber: '2026-03-001', natureOfPayment: 'Supplies', amount, status, cancelReason: null, cancelledDate: null, ...extra });
  const ds = memoryDs({
    bankAccounts: [{ id: 'B1', barangayId: 'AGBOY', bankName: 'LBP', branch: 'Kabankalan', accountNumber: '0012345678' }],
    signatories: [],
    checks: [chk('1762251', '2026-03-05', 5_000, 'CANCELLED', { cancelReason: 'Spoiled', cancelledDate: '2026-03-06' }), chk('1762250', '2026-03-02', 10_000), chk('1762252', '2026-03-09', 7_500, 'RELEASED'), chk('1762249', '2026-02-27', 1_000)],
  });
  it('lists every check number of the month in order, cancelled at zero', async () => {
    const m = await runReport(reportBuilder('CHECKS_ISSUED')!, ds, { barangayId: 'AGBOY', fiscalYear: 2026, month: 3 });
    const t = m.sections[0]!;
    if (t.kind !== 'table') throw new Error('table expected');
    expect(t.rows.map((r) => r.cells.checkNo)).toEqual(['1762250', '1762251', '1762252', undefined]);
    expect(t.rows[1]!.cells.amount).toBeNull();
    expect(t.rows.at(-1)!.cells.amount).toBe(17_500);
    expect(m.isEmpty).toBe(false);
  });
  it('cancelled checks report and empty month', async () => {
    const m = await runReport(reportBuilder('CANCELLED_CHECKS')!, ds, { barangayId: 'AGBOY', fiscalYear: 2026, month: 3 });
    expect(m.isEmpty).toBe(false);
    const e = await runReport(reportBuilder('CANCELLED_CHECKS')!, ds, { barangayId: 'AGBOY', fiscalYear: 2026, month: 4 });
    expect(e.isEmpty).toBe(true);
  });
});
