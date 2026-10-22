import type { ValidationResult } from '../constants/statuses';
import type { ReportDefinition } from '../types/reporting';

/**
 * ReportModel — the single, renderer-agnostic description of a report (docs 06 §13).
 * Builders are PURE (data → model). The same model is rendered as HTML/print, exported to XLSX,
 * and stored verbatim as a server snapshot (generatedReports). Money cells are integer centavos.
 */
export type ColumnType = 'text' | 'money' | 'number' | 'date' | 'percent' | 'code';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** Relative width hint (1 = narrow, 3 = wide). */
  width?: number;
  /** Optional upper header row grouping (consecutive columns with the same group are merged). */
  group?: string;
}

/** A cell is a raw value; its column type decides formatting. `null` renders blank. */
export type CellValue = string | number | null;

export type RowStyle = 'normal' | 'heading' | 'subheading' | 'subtotal' | 'total' | 'grandtotal' | 'note';

export interface ReportRow {
  cells: Record<string, CellValue>;
  style?: RowStyle;
  /** Indent level for the first text column (statements). */
  indent?: 0 | 1 | 2 | 3;
}

export interface TableSection {
  kind: 'table';
  title?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Text shown when there are no rows. */
  emptyText?: string;
}

export interface FieldsSection {
  kind: 'fields';
  title?: string;
  /** Grid of label/value pairs (form headers such as DV payee, OR no.). */
  fields: Array<{ label: string; value: CellValue; type?: ColumnType; span?: 1 | 2 | 3 | 4 }>;
  columns?: 2 | 3 | 4;
}

export interface TextSection {
  kind: 'text';
  title?: string;
  paragraphs: string[];
}

/** Box with certification text and a signature line (DV boxes A–E, LR certifications…). */
export interface CertificationsSection {
  kind: 'certifications';
  boxes: Array<{ label: string; text?: string; name: string; position: string; date?: string | null }>;
}

export type ReportSection = TableSection | FieldsSection | TextSection | CertificationsSection;

export interface ReportSignatory {
  /** "Prepared by", "Certified correct", "Approved by", "Noted by" … */
  label: string;
  name: string;
  position: string;
}

export interface ReportValidation {
  id: string;
  result: ValidationResult;
  message: string;
}

export interface ReportModel {
  code: string;
  title: string;
  /** Lines under the title: "For the month of September 2026", "Fund: General Fund". */
  subtitle: string[];
  /** The legacy agency header lines (Republic … / Province … / Municipality … / BARANGAY …). */
  agencyHeader: string[];
  /** Label/value pairs printed under the title (Accountable Officer, Bank Account, Report No.). */
  meta: Array<{ label: string; value: string }>;
  paper: { size: ReportDefinition['paperSize']; orientation: ReportDefinition['orientation'] };
  sections: ReportSection[];
  signatories: ReportSignatory[];
  validations: ReportValidation[];
  /** True when the report has no source records (monthly package marks it NOT_APPLICABLE). */
  isEmpty: boolean;
  /** ISO timestamp the model was built (set by the framework). */
  generatedAt?: string;
  /** Free-form footnotes. */
  notes?: string[];
}

// ------------------------------------------------------------------ builder helpers

export function col(key: string, label: string, type: ColumnType = 'text', extra: Partial<ReportColumn> = {}): ReportColumn {
  return { key, label, type, ...extra };
}

export function row(cells: Record<string, CellValue>, style: RowStyle = 'normal', indent?: ReportRow['indent']): ReportRow {
  return indent === undefined ? { cells, style } : { cells, style, indent };
}

export function table(columns: ReportColumn[], rows: ReportRow[], extra: Partial<Omit<TableSection, 'kind' | 'columns' | 'rows'>> = {}): TableSection {
  return { kind: 'table', columns, rows, ...extra };
}

export function validation(id: string, ok: boolean | 'WARNING', message: string): ReportValidation {
  return { id, result: ok === 'WARNING' ? 'WARNING' : ok ? 'PASSED' : 'FAILED', message };
}

/** Worst result wins: FAILED > WARNING > PASSED. */
export function overallValidation(v: readonly ReportValidation[]): ValidationResult {
  if (v.some((x) => x.result === 'FAILED')) return 'FAILED';
  if (v.some((x) => x.result === 'WARNING')) return 'WARNING';
  return 'PASSED';
}

/** Sum a money column across rows (ignores non-numeric cells). */
export function sumColumn(rows: readonly ReportRow[], key: string): number {
  let t = 0;
  for (const r of rows) {
    const v = r.cells[key];
    if (typeof v === 'number') t += v;
  }
  return t;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

export function monthLabel(fiscalYear: number, month: number): string {
  if (month === 0) return `Opening balances ${fiscalYear}`;
  if (month === 13) return `Closing entries ${fiscalYear}`;
  return `${MONTH_NAMES[month - 1]} ${fiscalYear}`;
}

/** Long date for print: 2026-09-30 → September 30, 2026. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}
