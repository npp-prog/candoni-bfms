import { lastDayOfMonth } from '../accounting/periods';
import type { ComplianceStatus, ValidationResult } from '../constants/statuses';
import type { BarangayId, IsoDate, Ts } from '../types/common';
import type { DeadlineRule, GeneratedReportDoc, ReportDefinition } from '../types/reporting';
import type { ParamKind, ReportParams } from './context';

/**
 * Phase 12 — Report Center (docs 06 §13, 05 §11–12): snapshot identity, deadlines, the monthly
 * submission package and the compliance matrix. Pure, shared by the functions and the UI.
 */

/** Extra fields stored on generatedReports beyond the frozen GeneratedReportDoc. */
export interface GeneratedReportRecord extends GeneratedReportDoc {
  title: string;
  /** Period identity: '2026-09', '2026', '2026-Q3', '2026-S1', an as-of date, or 'from..to'. */
  periodKey: string;
  /** Canonical JSON of the extra parameters (variant, bank account, document …). */
  filtersKey: string;
  params: ReportParams;
  /** Number of payload chunks under generatedReports/{id}/payload. */
  payloadChunks: number;
  isEmpty: boolean;
  overall: ValidationResult;
}

/** reportPackages/{bid}_{fy}_{mm} — the monthly submission package manifest. */
export interface ReportPackageDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  month: number;
  status: 'GENERATED' | 'SUBMITTED' | 'RESUBMITTED' | 'RETURNED' | 'ACCEPTED';
  items: PackageItem[];
  overall: ValidationResult;
  generatedAt: Ts;
  generatedBy: string;
  submittedAt: Ts | null;
  submittedBy: string | null;
  revisionNumber: number;
}

export interface PackageItem {
  reportCode: string;
  reportName: string;
  /** One entry per snapshot (RAO per class, RCD per report …). */
  reports: Array<{ id: string; version: number; label: string; overall: ValidationResult }>;
  status: 'GENERATED' | 'NOT_APPLICABLE' | 'FAILED' | 'ACCEPTED' | 'RETURNED';
  overall: ValidationResult | null;
  dueDate: IsoDate | null;
  remarks: string | null;
}

/** Cell id of the compliance matrix. */
export function submissionId(barangayId: string, fiscalYear: number, month: number, reportCode: string): string {
  return `${barangayId}_${fiscalYear}_${String(month).padStart(2, '0')}_${reportCode}`;
}

export function packageId(barangayId: string, fiscalYear: number, month: number): string {
  return `${barangayId}_${fiscalYear}_${String(month).padStart(2, '0')}`;
}

const FILTER_KEYS = ['documentId', 'variant', 'fundId', 'bankAccountId', 'accountCode', 'subsidiaryId', 'itemId'] as const;

/** Identity of a snapshot: same code + periodKey + filtersKey ⇒ a new version of the same report. */
export function snapshotIdentity(kind: ParamKind, p: ReportParams): { periodKey: string; filtersKey: string; from: string; to: string } {
  const fy = p.fiscalYear;
  const mm = (m: number) => `${fy}-${String(m).padStart(2, '0')}`;
  let periodKey: string;
  let from: string;
  let to: string;
  switch (kind) {
    case 'MONTH':
      periodKey = from = to = mm(p.month ?? 1);
      break;
    case 'QUARTER':
      periodKey = `${fy}-Q${p.quarter ?? 1}`;
      from = mm(((p.quarter ?? 1) - 1) * 3 + 1);
      to = mm((p.quarter ?? 1) * 3);
      break;
    case 'SEMESTER':
      periodKey = `${fy}-S${p.semester ?? 1}`;
      from = mm(p.semester === 2 ? 7 : 1);
      to = mm(p.semester === 2 ? 12 : 6);
      break;
    case 'AS_OF': {
      const d = p.asOf ?? (p.month ? lastDayOfMonth(fy, p.month) : `${fy}-12-31`);
      periodKey = d;
      from = mm(1);
      to = d.slice(0, 7);
      break;
    }
    case 'RANGE':
      periodKey = `${p.dateFrom ?? ''}..${p.dateTo ?? ''}`;
      from = (p.dateFrom ?? `${fy}-01`).slice(0, 7);
      to = (p.dateTo ?? `${fy}-12`).slice(0, 7);
      break;
    case 'DOCUMENT':
      periodKey = `DOC:${p.documentId ?? ''}`;
      from = mm(1);
      to = mm(12);
      break;
    default:
      periodKey = String(fy);
      from = mm(1);
      to = mm(12);
  }
  const filters: Record<string, string> = {};
  for (const k of FILTER_KEYS) if (p[k] !== undefined && p[k] !== null && p[k] !== '') filters[k] = String(p[k]);
  return { periodKey, filtersKey: JSON.stringify(filters), from, to };
}

/** Due date of a report for a month (monthly) or year (annual), per its deadline rule. */
export function dueDate(rule: DeadlineRule, fiscalYear: number, month: number | null): IsoDate | null {
  const add = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const periodEnd = month ? lastDayOfMonth(fiscalYear, month) : `${fiscalYear}-12-31`;
  switch (rule.kind) {
    case 'DAYS_AFTER_PERIOD_END':
      return add(periodEnd, rule.days);
    case 'DAY_OF_FOLLOWING_MONTH': {
      const m = month ?? 12;
      const y = m === 12 ? fiscalYear + 1 : fiscalYear;
      const nm = m === 12 ? 1 : m + 1;
      return `${y}-${String(nm).padStart(2, '0')}-${String(Math.min(rule.day, Number(lastDayOfMonth(y, nm).slice(8)))).padStart(2, '0')}`;
    }
    case 'FIXED_DATE_NEXT_YEAR':
      return `${fiscalYear + 1}-${String(rule.month).padStart(2, '0')}-${String(rule.day).padStart(2, '0')}`;
    default:
      return null;
  }
}

/** Reports that belong in the monthly package for a barangay (docs 05 §11). */
export function packageDefinitions(defs: readonly ReportDefinition[]): ReportDefinition[] {
  return defs.filter((d) => d.active && d.inMonthlyPackage && d.reportCode !== 'TRANSMITTAL');
}

/** Status shown in the compliance matrix, including OVERDUE derived from the due date. */
export function effectiveStatus(status: ComplianceStatus | undefined, due: IsoDate | null, today: IsoDate): ComplianceStatus {
  const s = status ?? 'NOT_STARTED';
  if (due && today > due && ['NOT_STARTED', 'DRAFT', 'GENERATED', 'RETURNED'].includes(s)) return 'OVERDUE';
  return s;
}

/** Canonical JSON (sorted keys) for hashing a report model. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
