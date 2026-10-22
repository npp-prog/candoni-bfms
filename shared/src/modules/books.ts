import type { BarangayId, Ts } from '../types/common';
import type { SourceModuleDef } from './types';

// The FS mapping helpers live in accounting/; re-exported here because shared/src/index.ts only
// knows this module file.
export * from '../accounting/fsStatements';

/** Phases 8 & 11 — books of accounts and financial statements: source-document module definitions (none: books read posted JEVs). */
export const BOOKS_MODULES: SourceModuleDef[] = [];

export const TB_VARIANTS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'PRE_CLOSING', label: 'Pre-closing (December 31, before closing entries)' },
  { value: 'POST_CLOSING', label: 'Post-closing (after closing entries)' },
] as const;
export type TbVariant = (typeof TB_VARIANTS)[number]['value'];

/** Months a trial balance variant sums (periods 00 … 13, docs 04 §9 "Balances model"). */
export function tbMonths(variant: string | undefined, month: number): { throughMonth: number; includeClosing: boolean } {
  if (variant === 'PRE_CLOSING') return { throughMonth: 12, includeClosing: false };
  if (variant === 'POST_CLOSING') return { throughMonth: 13, includeClosing: true };
  return { throughMonth: Math.min(Math.max(month, 1), 12), includeClosing: false };
}

/** Human labels for generated-JEV sources (JEV register and JEV form). */
export const JEV_SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'Manual',
  IMPORT: 'Import',
  COLLECTION: 'Collection (OR)',
  RCD: 'RCD',
  DEPOSIT: 'Deposit',
  DV: 'Disbursement voucher',
  CHECK: 'Check',
  PAYROLL: 'Payroll',
  CASH_ADVANCE: 'Cash advance',
  LIQUIDATION: 'Liquidation',
  PETTY_CASH: 'Petty cash',
  STF: 'Special trust fund',
  BANK_MEMO: 'Bank memo',
  DEPRECIATION: 'Depreciation',
  INVENTORY: 'Inventory',
  CLOSING: 'Closing entries',
};

// ------------------------------------------------------------------ Notes to Financial Statements

export interface NfsNote {
  title: string;
  body: string;
}

/**
 * nfsNarratives/{bid}_{fy} — narrative notes (HYBRID NFS report). Every save bumps `version` and
 * appends nfsNarratives/{id}/versions/{version}. Phase 12 freezes it (status FINAL) on finalize.
 */
export interface NfsNarrativeDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  notes: NfsNote[];
  version: number;
  status: 'DRAFT' | 'FINAL';
  createdAt: Ts;
  createdBy: string;
  updatedAt: Ts;
  updatedBy: string;
}

export interface NfsNarrativeVersionDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  version: number;
  notes: NfsNote[];
  savedAt: Ts;
  savedBy: string;
}

export const NFS_LIMITS = { maxNotes: 40, maxTitle: 200, maxBody: 20000 } as const;

export function nfsNarrativeId(barangayId: string, fiscalYear: number): string {
  return `${barangayId}_${fiscalYear}`;
}

/** Starting narrative (the standard opening notes of barangay financial statements). */
export function defaultNfsNotes(barangayName: string, fiscalYear: number): NfsNote[] {
  return [
    {
      title: 'General Information',
      body: `Barangay ${barangayName} is a basic political unit of the Municipality of Candoni, Province of Negros Occidental, created and governed under Republic Act No. 7160 (Local Government Code of 1991). It serves as the primary planning and implementing unit of government policies, plans, programs, projects and activities in the community.\n\nThe financial statements for the year ended December 31, ${fiscalYear} were authorized for issue by the Punong Barangay.`,
    },
    {
      title: 'Statement of Compliance and Basis of Preparation',
      body: 'The financial statements have been prepared in compliance with the Philippine Public Sector Accounting Standards (PPSAS) and the Manual on the Financial Management of Barangays prescribed by the Commission on Audit. The financial statements are prepared on the accrual basis of accounting and are presented in Philippine Peso.',
    },
    {
      title: 'Summary of Significant Accounting Policies',
      body: 'Cash and cash equivalents comprise cash in local treasury, petty cash and cash in bank. Receivables are stated at face value less allowance for impairment. Property, plant and equipment are carried at cost less accumulated depreciation; depreciation is computed using the straight-line method over the estimated useful life, with a residual value of five percent of cost. Revenue from the share in national taxes is recognized when the notice of allocation is received; other revenue is recognized when collected. Expenses are recognized when incurred.',
    },
  ];
}
