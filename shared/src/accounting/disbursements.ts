import type { Centavos, IsoDate } from '../types/common';
import type { PayrollEntry } from '../types/treasury';
import { BfmsError } from './errors';
import { applyRateBp, assertCentavos } from './money';
import { assertIsoDate } from './periods';

/**
 * Phase 5 pure helpers (DV arithmetic, JCT template, payroll totals). Used by the server (which
 * recomputes everything) and by the UI for live previews, so both always agree to the centavo.
 */

/** Accounts the DV template uses (all in coaSeed). */
export const DV_ACCT = {
  DUE_TO_BIR: '2-02-01-010',
  CASH_IN_BANK: '1-01-02-010',
  CASH_LOCAL_TREASURY: '1-01-01-010',
  ADVANCES_PAYROLL: '1-03-03-010',
  ADVANCES_OFFICERS: '1-03-03-020',
} as const;
export const DV_CASH_ADVANCE_ACCOUNTS: readonly string[] = [DV_ACCT.ADVANCES_PAYROLL, DV_ACCT.ADVANCES_OFFICERS];

/** Max payees in one payroll document (entries are stored inline; keeps the doc far below 1 MiB). */
export const PAYROLL_MAX_ENTRIES = 200;

/** Charges to expense (5-) or capital outlay (1-06/1-07/1-08) accounts need a certified obligation. */
export function dvRequiresObligation(accountCode: string): boolean {
  return accountCode.startsWith('5-') || /^1-0[678]/.test(accountCode);
}

export interface DvChargeInput {
  accountCode: string;
  subsidiaryId: string | null;
  amount: Centavos | number;
}
export interface DvTaxInput {
  taxType: 'EWT' | 'VAT' | 'PT' | 'DST' | 'OTHER';
  rateBp: number;
  /** Taxable base; defaults to the gross amount. */
  base?: Centavos | number | null;
}
export interface DvOtherDeductionInput {
  description: string;
  accountCode: string;
  subsidiaryId: string | null;
  amount: Centavos | number;
}

export interface DvTotals {
  grossAmount: Centavos;
  taxDeductions: Array<{ taxType: DvTaxInput['taxType']; rateBp: number; base: Centavos; amount: Centavos }>;
  totalTaxes: Centavos;
  totalOtherDeductions: Centavos;
  netAmount: Centavos;
}

/** gross = Σ charges; tax = rate × base (rounded half away from zero); net = gross − taxes − other deductions. */
export function computeDvTotals(input: { charges: readonly DvChargeInput[]; taxes: readonly DvTaxInput[]; otherDeductions: readonly DvOtherDeductionInput[] }): DvTotals {
  if (!input.charges.length) throw new BfmsError('VALIDATION_FAILED', 'Enter at least one charge (account and amount).');
  input.charges.forEach((c, i) => {
    assertCentavos(c.amount as Centavos, `charge ${i + 1}`);
    if (c.amount <= 0) throw new BfmsError('VALIDATION_FAILED', `Charge ${i + 1}: amount must be greater than zero.`);
  });
  const grossAmount = input.charges.reduce((t, c) => t + c.amount, 0) as Centavos;
  const taxDeductions = input.taxes.map((t, i) => {
    if (!Number.isInteger(t.rateBp) || t.rateBp <= 0 || t.rateBp > 10000) throw new BfmsError('VALIDATION_FAILED', `Tax ${i + 1}: rate must be between 0.01% and 100%.`);
    const base = (t.base ?? grossAmount) as Centavos;
    assertCentavos(base, `tax ${i + 1} base`);
    if (base <= 0 || base > grossAmount) throw new BfmsError('VALIDATION_FAILED', `Tax ${i + 1}: the taxable base must be between zero and the gross amount.`);
    return { taxType: t.taxType, rateBp: t.rateBp, base, amount: applyRateBp(base, t.rateBp) };
  });
  input.otherDeductions.forEach((d, i) => {
    assertCentavos(d.amount as Centavos, `deduction ${i + 1}`);
    if (d.amount <= 0) throw new BfmsError('VALIDATION_FAILED', `Deduction ${i + 1}: amount must be greater than zero.`);
  });
  const totalTaxes = taxDeductions.reduce((t, x) => t + x.amount, 0) as Centavos;
  const totalOtherDeductions = input.otherDeductions.reduce((t, d) => t + d.amount, 0) as Centavos;
  const netAmount = (grossAmount - totalTaxes - totalOtherDeductions) as Centavos;
  if (netAmount <= 0) throw new BfmsError('VALIDATION_FAILED', 'Deductions leave nothing to pay: the net amount must be greater than zero.', { grossAmount, totalTaxes, totalOtherDeductions });
  return { grossAmount, taxDeductions, totalTaxes, totalOtherDeductions, netAmount };
}

export interface DvJournalLine {
  accountCode: string;
  subsidiaryId: string | null;
  debit: Centavos;
  credit: Centavos;
  lineDescription: string;
}

/**
 * JCT template for a paid DV (docs 04 §9):
 *   Dr charges (account + SL) · Cr 2-02-01-010 (BIR SL) for taxes withheld · Cr other deductions ·
 *   Cr cash (1-01-02-010 CIB## for check/ADA, 1-01-01-010 BT## for cash) for the net amount.
 * A cash-advance DV is the same template with the charge on 1-03-03-010/020 (AO##/EO##).
 */
export function dvJournalLines(
  dv: { charges: readonly DvChargeInput[]; taxDeductions: ReadonlyArray<{ taxType: string; amount: Centavos | number }>; otherDeductions: readonly DvOtherDeductionInput[]; netAmount: Centavos | number; taxSubsidiaryId?: string | null },
  cash: { accountCode: string; subsidiaryId: string | null },
): DvJournalLine[] {
  const z = 0 as Centavos;
  const lines: DvJournalLine[] = dv.charges.map((c) => ({ accountCode: c.accountCode, subsidiaryId: c.subsidiaryId ?? null, debit: c.amount as Centavos, credit: z, lineDescription: '' }));
  for (const t of dv.taxDeductions) if (t.amount > 0) lines.push({ accountCode: DV_ACCT.DUE_TO_BIR, subsidiaryId: dv.taxSubsidiaryId ?? null, debit: z, credit: t.amount as Centavos, lineDescription: `${t.taxType} withheld` });
  for (const d of dv.otherDeductions) if (d.amount > 0) lines.push({ accountCode: d.accountCode, subsidiaryId: d.subsidiaryId ?? null, debit: z, credit: d.amount as Centavos, lineDescription: d.description });
  lines.push({ accountCode: cash.accountCode, subsidiaryId: cash.subsidiaryId, debit: z, credit: dv.netAmount as Centavos, lineDescription: '' });
  const dr = lines.reduce((t, l) => t + l.debit, 0);
  const cr = lines.reduce((t, l) => t + l.credit, 0);
  if (dr !== cr) throw new BfmsError('UNBALANCED_ENTRY', `DV entry does not balance (Dr ${dr} ≠ Cr ${cr}); recompute the voucher.`);
  return lines;
}

/** Calendar arithmetic on YYYY-MM-DD (UTC, no DST issues). */
export function dvAddDays(date: IsoDate, days: number): IsoDate {
  assertIsoDate(date);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Default liquidation periods if systemSettings/aging is missing a type (same as the seed). */
export const DV_DEFAULT_LIQUIDATION_DUE_DAYS: Readonly<Record<string, number>> = { PAYROLL: 5, OFFICIAL_TRAVEL: 30, SPECIAL_PURPOSE: 20, PETTY_CASH: 365, OTHER_AUTHORIZED: 30 };

export function dvLiquidationDueDate(grantDate: IsoDate, cashAdvanceType: string, dueDays?: Readonly<Record<string, number>> | null): IsoDate {
  const d = dueDays?.[cashAdvanceType] ?? DV_DEFAULT_LIQUIDATION_DUE_DAYS[cashAdvanceType] ?? 30;
  return dvAddDays(grantDate, d);
}

// ------------------------------------------------------------------ payroll

export interface PayrollEntryInput {
  payeeId?: string | null;
  payeeName: string;
  position: string;
  grossAmount: Centavos | number;
  deductions: ReadonlyArray<{ description: string; accountCode: string; amount: Centavos | number }>;
  signed?: boolean;
}

/** Recompute every entry's net and the payroll totals; zero deductions are dropped. */
export function computePayroll(entries: readonly PayrollEntryInput[]): { entries: PayrollEntry[]; entryCount: number; grossAmount: Centavos; totalDeductions: Centavos; netAmount: Centavos } {
  if (!entries.length) throw new BfmsError('VALIDATION_FAILED', 'A payroll needs at least one payee.');
  if (entries.length > PAYROLL_MAX_ENTRIES) throw new BfmsError('TOO_MANY_LINES', `A payroll may list at most ${PAYROLL_MAX_ENTRIES} payees; split it into several payrolls.`);
  let gross = 0;
  let ded = 0;
  const out: PayrollEntry[] = entries.map((e, i) => {
    const n = i + 1;
    assertCentavos(e.grossAmount as Centavos, `payee ${n} gross`);
    if (e.grossAmount <= 0) throw new BfmsError('VALIDATION_FAILED', `Payee ${n} (${e.payeeName}): gross amount must be greater than zero.`);
    const deductions = e.deductions.filter((d) => d.amount !== 0).map((d) => {
      assertCentavos(d.amount as Centavos, `payee ${n} deduction`);
      if (d.amount < 0) throw new BfmsError('VALIDATION_FAILED', `Payee ${n}: deductions cannot be negative.`);
      return { description: d.description, accountCode: d.accountCode, amount: d.amount as Centavos };
    });
    const totalDed = deductions.reduce((t, d) => t + d.amount, 0);
    const netAmount = (e.grossAmount - totalDed) as Centavos;
    if (netAmount < 0) throw new BfmsError('VALIDATION_FAILED', `Payee ${n} (${e.payeeName}): deductions exceed the gross amount.`);
    gross += e.grossAmount;
    ded += totalDed;
    return { payeeId: e.payeeId ?? null, payeeName: e.payeeName, position: e.position, grossAmount: e.grossAmount as Centavos, deductions, netAmount, signed: e.signed ?? false };
  });
  return { entries: out, entryCount: out.length, grossAmount: gross as Centavos, totalDeductions: ded as Centavos, netAmount: (gross - ded) as Centavos };
}

/** Distinct deduction columns (account + description), in first-seen order — payroll grid and form. */
export function payrollDeductionColumns(entries: ReadonlyArray<Pick<PayrollEntry, 'deductions'>>): Array<{ key: string; description: string; accountCode: string }> {
  const seen = new Map<string, { key: string; description: string; accountCode: string }>();
  for (const e of entries) for (const d of e.deductions) {
    const key = `${d.accountCode}|${d.description}`;
    if (!seen.has(key)) seen.set(key, { key, description: d.description, accountCode: d.accountCode });
  }
  return [...seen.values()];
}

/** Payroll deductions summed per account (the "other deductions" of the payroll DV). */
export function aggregatePayrollDeductions(entries: ReadonlyArray<Pick<PayrollEntry, 'deductions'>>): Array<{ description: string; accountCode: string; amount: Centavos }> {
  const by = new Map<string, { description: string; accountCode: string; amount: number }>();
  for (const e of entries) for (const d of e.deductions) {
    const cur = by.get(d.accountCode);
    if (cur) cur.amount += d.amount;
    else by.set(d.accountCode, { description: d.description, accountCode: d.accountCode, amount: d.amount });
  }
  return [...by.values()].filter((d) => d.amount > 0).map((d) => ({ ...d, amount: d.amount as Centavos }));
}
