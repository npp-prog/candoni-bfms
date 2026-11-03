import type { TransactionType } from '../constants/transactionTypes';
import type { SubsidiaryType } from '../types/coa';
import type { Centavos } from '../types/common';
import type { PpeScheduleRow } from '../types/accountingSchedules';
import type { ImportCancelledCheck, ImportEntry, ImportLegacyCashAdvance, ImportOpening, ImportPpeRow, ImportSubsidiary } from './workbookImport';

/**
 * Wire contract between the import page and the import callables
 * (functions/src/modules/import/callables.ts). The browser parses the workbook and sends the
 * normalised parts in batches; the server re-validates everything and recomputes all totals.
 */

export const IMPORT_PARTS = ['SUBSIDIARIES', 'OPENING', 'JOURNAL', 'PRIOR_YEARS', 'CASH_ADVANCES', 'PPE', 'CANCELLED_CHECKS'] as const;
export type ImportPart = (typeof IMPORT_PARTS)[number];

export const IMPORT_PART_LABELS: Record<ImportPart, string> = {
  SUBSIDIARIES: 'Subsidiary ledgers (ACODE SL list)',
  OPENING: 'Opening balances (PY DB → period 00)',
  JOURNAL: 'Current-year journal (01_CY DB)',
  PRIOR_YEARS: 'Prior-year pre-closing TB (comparatives)',
  CASH_ADVANCES: 'Legacy unliquidated cash advances',
  PPE: 'PPE depreciation schedule',
  CANCELLED_CHECKS: 'Cancelled checks',
};

export const IMPORT_LIMITS = {
  entriesPerCall: 120,
  linesPerCall: 900,
  subsidiariesPerCall: 400,
  cashAdvancesPerCall: 400,
  cancelledChecksPerCall: 400,
} as const;

export const IMPORT_KEY_RE = /^[A-Za-z0-9-]{1,40}$/;

export interface ImportEntryPayload {
  key: string;
  date: string;
  transactionType: TransactionType;
  primaryReference: string | null;
  secondaryReference: string | null;
  tertiaryReference: string | null;
  payeeName: string | null;
  particulars: string;
  lines: Array<{ accountCode: string; subsidiaryCode: string | null; debit: Centavos; credit: Centavos }>;
  legacyRows: number[];
}

export type ImportSubsidiaryPayload = Pick<ImportSubsidiary, 'accountCode' | 'subsidiaryCode' | 'subsidiaryName'> & { type: SubsidiaryType };

export type ImportCashAdvancePayload = Omit<ImportLegacyCashAdvance, 'sheet' | 'row'>;

export type ImportPpePayload = PpeScheduleRow;

export interface ImportCancelledCheckPayload {
  checkNumber: string;
  checkDate: string;
  payeeName: string | null;
  dvNumber: string | null;
}

export interface ImportPriorYearPayload {
  fiscalYear: number;
  rows: Array<{ accountCode: string; debit: Centavos; credit: Centavos }>;
}

/** What the server knows about earlier imports / postings for a barangay-year (importStatus). */
export interface ImportStatus {
  barangayId: string;
  fiscalYear: number;
  fiscalYearOpen: boolean;
  openingPosted: boolean;
  journalImported: boolean;
  /** Posted REGULAR entries that are not imports (the journal import would break JEV-number order). */
  otherPostedEntries: boolean;
  legacyBalanceYears: number[];
  cashAdvancesImported: boolean;
  ppeScheduleExists: boolean;
  bankAccounts: Array<{ id: string; label: string; subsidiaryCode: string | null }>;
  existingSubsidiaries: string[]; // `${accountCode}|${subsidiaryCode}`
  inProgress: { importId: string; fingerprint: string; createdBy: string; createdByName: string; parts: ImportPart[] } | null;
  /** Parts that can be imported now, with the reason when not. */
  blocked: Partial<Record<ImportPart, string>>;
}

export function toEntryPayload(e: ImportEntry): ImportEntryPayload {
  return {
    key: e.key,
    date: e.date!,
    transactionType: e.transactionType,
    primaryReference: e.primaryReference,
    secondaryReference: e.secondaryReference,
    // The legacy JEV no. (WEST: 09-2025-07-001) is kept as the tertiary reference.
    tertiaryReference: e.legacyJevNo ?? e.tertiaryReference,
    payeeName: e.payeeName,
    particulars: e.particulars,
    lines: e.lines.map((l) => ({ accountCode: l.accountCode, subsidiaryCode: l.subsidiaryCode, debit: l.debit, credit: l.credit })),
    legacyRows: e.rows.slice(0, 200),
  };
}

export function openingPayload(o: ImportOpening, fiscalYear: number): ImportEntryPayload {
  return {
    key: 'OPENING',
    date: `${fiscalYear}-01-01`,
    transactionType: 'OPENING',
    primaryReference: null,
    secondaryReference: null,
    tertiaryReference: null,
    payeeName: null,
    particulars: `Opening balances as of January 1, ${fiscalYear} (imported from the legacy workbook, ${o.sheet})`,
    lines: o.lines.map((l) => ({ accountCode: l.accountCode, subsidiaryCode: l.subsidiaryCode, debit: l.debit, credit: l.credit })),
    legacyRows: o.lines.map((l) => l.row).slice(0, 200),
  };
}

export function toPpePayload(r: ImportPpeRow): ImportPpePayload {
  const { accountCode, costOverride, residualRateBp, usefulLifeYears, accumulatedAccountCode, expenseAccountCode, remarks } = r;
  return { accountCode, costOverride, residualRateBp, usefulLifeYears, accumulatedAccountCode, expenseAccountCode, remarks };
}

export function toCancelledCheckPayloads(list: readonly ImportCancelledCheck[]): ImportCancelledCheckPayload[] {
  return list
    .filter((c) => c.date && /^[0-9A-Za-z-]{3,20}$/.test(c.checkNumber))
    .map((c) => ({ checkNumber: c.checkNumber, checkDate: c.date!, payeeName: c.payeeName, dvNumber: c.dvNumber }));
}

/** Split date-ordered entries into calls within IMPORT_LIMITS (order preserved). */
export function chunkEntries<T extends { lines: unknown[] }>(entries: readonly T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let lines = 0;
  for (const e of entries) {
    if (cur.length && (cur.length >= IMPORT_LIMITS.entriesPerCall || lines + e.lines.length > IMPORT_LIMITS.linesPerCall)) {
      out.push(cur);
      cur = [];
      lines = 0;
    }
    cur.push(e);
    lines += e.lines.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
