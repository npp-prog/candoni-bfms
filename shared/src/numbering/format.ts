import type { BarangayId } from '../types/common';

/**
 * Document numbering (docs/architecture/04-accounting-engine.md §18).
 * Counters run per barangay per fiscal year (across months), matching legacy JEV/DV numbers
 * like 2025-01-003 → 2025-02-004.
 */
export const NUMBER_FORMATS = {
  JEV: { prefix: '', format: '{YYYY}-{MM}-{N:3}' },
  DV: { prefix: '', format: '{YYYY}-{MM}-{N:3}' },
  RCD: { prefix: '', format: '{YYYY}-{MM}-{N:3}' },
  OBR: { prefix: 'OBR', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
  LR: { prefix: 'LR', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
  PAYROLL: { prefix: 'PR', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
  PCV: { prefix: 'PCV', format: '{PREFIX}-{YYYY}-{N:4}' },
  ICS: { prefix: 'ICS', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
  PAR: { prefix: 'PAR', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
  RIS: { prefix: 'RIS', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
  IAR: { prefix: 'IAR', format: '{PREFIX}-{YYYY}-{MM}-{N:3}' },
} as const;

export type NumberedDocType = keyof typeof NUMBER_FORMATS;

export function sequenceDocId(barangayId: BarangayId, fiscalYear: number, docType: string): string {
  return `${barangayId}_${fiscalYear}_${docType}`;
}

export function uniqueKeyId(scope: string, ...parts: Array<string | number>): string {
  // Firestore IDs may not contain '/'; normalise whitespace.
  return [scope, ...parts].map((p) => String(p).replace(/\//g, '-').replace(/\s+/g, '')).join('_');
}

/** Render `{PREFIX}-{YYYY}-{MM}-{N:3}` tokens. `month` is the document's accounting month. */
export function formatDocumentNumber(format: string, prefix: string, fiscalYear: number, month: number, n: number): string {
  if (!Number.isInteger(n) || n <= 0) throw new Error('sequence number must be a positive integer');
  return format
    .replace('{PREFIX}', prefix)
    .replace('{YYYY}', String(fiscalYear))
    .replace('{MM}', String(month).padStart(2, '0'))
    .replace(/\{N:(\d+)\}/, (_, w: string) => String(n).padStart(Number(w), '0'));
}

/** Parse legacy JEV/DV numbers (YYYY-MM-NNN). */
export function parseLegacyNumber(v: string): { fiscalYear: number; month: number; n: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{3,})$/.exec(v.trim());
  return m ? { fiscalYear: Number(m[1]), month: Number(m[2]), n: Number(m[3]) } : null;
}
