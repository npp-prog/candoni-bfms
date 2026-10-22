import { BARANGAYS, MUNICIPALITY, PROVINCE } from '../constants/barangays';
import { reportDefinition } from '../constants/reportDefinitions';
import { lastDayOfMonth } from '../accounting/periods';
import type { ChartOfAccountDoc, SubsidiaryAccountDoc } from '../types/coa';
import type { BarangayId, IsoDate } from '../types/common';
import type { SignatoryDoc, SignatoryRole } from '../types/identity';
import type { ReportDefinition } from '../types/reporting';
import type { DataSource, WithId } from './datasource';
import { MONTH_NAMES, monthLabel, type ReportModel, type ReportSignatory } from './model';

/** What the period picker asks for. */
export type ParamKind = 'MONTH' | 'QUARTER' | 'SEMESTER' | 'YEAR' | 'DOCUMENT' | 'AS_OF' | 'RANGE';

export interface ReportParams {
  barangayId: BarangayId;
  fiscalYear: number;
  month?: number; // 1–12
  quarter?: 1 | 2 | 3 | 4;
  semester?: 1 | 2;
  dateFrom?: IsoDate;
  dateTo?: IsoDate;
  asOf?: IsoDate;
  documentId?: string;
  fundId?: string;
  bankAccountId?: string;
  accountCode?: string;
  subsidiaryId?: string;
  itemId?: string;
  variant?: string;
}

export interface ExtraParam {
  key: 'fundId' | 'bankAccountId' | 'accountCode' | 'subsidiaryId' | 'itemId' | 'variant';
  label: string;
  /** How the UI renders the picker. `select` uses `options`. */
  kind: 'fund' | 'bankAccount' | 'account' | 'subsidiary' | 'inventoryItem' | 'ppe' | 'select';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
}

/** Source document a FORM-type report prints (DV, LR, PAYROLL, OR …). */
export interface DocumentPicker {
  collection: string;
  /** Field shown as the document number in the picker. */
  numberField: string;
  dateField: string;
  /** Secondary text in the picker (payee name, particulars). */
  labelField?: string;
}

/** Body returned by a builder; the framework adds code, header, paper and timestamps. */
export type ReportBody = Omit<ReportModel, 'code' | 'agencyHeader' | 'paper' | 'generatedAt' | 'title'> & { title?: string };

export interface ReportBuilder {
  code: string;
  params: ParamKind;
  document?: DocumentPicker;
  extras?: ExtraParam[];
  build(ctx: ReportContext): Promise<ReportBody>;
}

export interface ReportContext {
  ds: DataSource;
  params: ReportParams;
  definition: ReportDefinition;
  barangayName: string;
  /** Inclusive date range implied by the params (month, quarter, year, range, as-of). */
  range: { from: IsoDate; to: IsoDate; label: string };
  /** Chart of Accounts keyed by code (loaded once, cached). */
  accounts(): Promise<Map<string, ChartOfAccountDoc>>;
  /** Subsidiary accounts of this barangay keyed by id (cached). */
  subsidiaries(): Promise<Map<string, WithId<SubsidiaryAccountDoc>>>;
  /** Signature block resolved from `signatories` for the role, as of `asOf` (default: range end). */
  sign(label: string, role: SignatoryRole, asOf?: IsoDate): ReportSignatory;
  /** Common filters every barangay-owned query needs. */
  scope(): Array<readonly [string, '==', unknown]>;
}

/** Resolve the inclusive date range for params. */
export function paramRange(kind: ParamKind, p: ReportParams): { from: IsoDate; to: IsoDate; label: string } {
  const fy = p.fiscalYear;
  switch (kind) {
    case 'MONTH': {
      const m = p.month ?? 1;
      return { from: `${fy}-${String(m).padStart(2, '0')}-01`, to: lastDayOfMonth(fy, m), label: `For the month of ${monthLabel(fy, m)}` };
    }
    case 'QUARTER': {
      const q = p.quarter ?? 1;
      const m1 = (q - 1) * 3 + 1;
      return { from: `${fy}-${String(m1).padStart(2, '0')}-01`, to: lastDayOfMonth(fy, m1 + 2), label: `For the quarter ended ${MONTH_NAMES[m1 + 1]} ${lastDayOfMonth(fy, m1 + 2).slice(8)}, ${fy}` };
    }
    case 'SEMESTER': {
      const s = p.semester ?? 1;
      const m1 = s === 1 ? 1 : 7;
      return { from: `${fy}-${String(m1).padStart(2, '0')}-01`, to: lastDayOfMonth(fy, m1 + 5), label: `For the semester ended ${MONTH_NAMES[m1 + 4]} ${lastDayOfMonth(fy, m1 + 5).slice(8)}, ${fy}` };
    }
    case 'RANGE':
      return { from: p.dateFrom ?? `${fy}-01-01`, to: p.dateTo ?? `${fy}-12-31`, label: `For the period ${p.dateFrom ?? `${fy}-01-01`} to ${p.dateTo ?? `${fy}-12-31`}` };
    case 'AS_OF': {
      const to = p.asOf ?? (p.month ? lastDayOfMonth(fy, p.month) : `${fy}-12-31`);
      return { from: `${fy}-01-01`, to, label: `As of ${MONTH_NAMES[Number(to.slice(5, 7)) - 1]} ${Number(to.slice(8))}, ${to.slice(0, 4)}` };
    }
    case 'YEAR':
    case 'DOCUMENT':
    default:
      return { from: `${fy}-01-01`, to: `${fy}-12-31`, label: `For the year ended December 31, ${fy}` };
  }
}

export function agencyHeaderLines(barangayName: string): string[] {
  return ['Republic of the Philippines', `Province of ${PROVINCE}`, `Municipality of ${MUNICIPALITY}`, `BARANGAY ${barangayName.toUpperCase()}`];
}

const SIGNATORY_FALLBACK: Record<SignatoryRole, string> = {
  PUNONG_BARANGAY: 'Punong Barangay',
  BARANGAY_TREASURER: 'Barangay Treasurer',
  BARANGAY_SECRETARY: 'Barangay Secretary',
  APPROPRIATIONS_CHAIR: 'Chairperson, Committee on Appropriations',
  PROPERTY_OFFICER: 'Property / Inventory Officer',
  MUNICIPAL_ACCOUNTANT: 'Municipal Accountant',
  COA_AUDITOR: 'COA Auditor',
};

/** Build and decorate a report. Used identically by the browser and by generateReportSnapshot. */
export async function runReport(builder: ReportBuilder, ds: DataSource, params: ReportParams, now: Date = new Date()): Promise<ReportModel> {
  const def = reportDefinition(builder.code);
  if (!def) throw new Error(`No report definition for ${builder.code}`);
  const barangayName = BARANGAYS.find((b) => b.barangayId === params.barangayId)?.barangayName ?? params.barangayId;
  const range = paramRange(builder.params, params);

  const sigs = [
    ...(await ds.list<SignatoryDoc>('signatories', [['barangayId', '==', params.barangayId], ['active', '==', true]])),
    ...(await ds.list<SignatoryDoc>('signatories', [['barangayId', '==', 'MUNICIPAL'], ['active', '==', true]])),
  ];
  let accountsCache: Map<string, ChartOfAccountDoc> | null = null;
  let slCache: Map<string, WithId<SubsidiaryAccountDoc>> | null = null;

  const ctx: ReportContext = {
    ds,
    params,
    definition: def,
    barangayName,
    range,
    async accounts() {
      if (!accountsCache) accountsCache = new Map((await ds.list<ChartOfAccountDoc>('chartOfAccounts', [], [['accountCode', 'asc']])).map((a) => [a.accountCode, a]));
      return accountsCache;
    },
    async subsidiaries() {
      if (!slCache) slCache = new Map((await ds.list<SubsidiaryAccountDoc>('subsidiaryAccounts', [['barangayId', '==', params.barangayId]])).map((s) => [s.id, s]));
      return slCache;
    },
    sign(label, role, asOf) {
      const date = asOf ?? range.to;
      const s = sigs
        .filter((x) => x.role === role && x.validFrom <= date && (!x.validTo || x.validTo >= date))
        .sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
      return { label, name: s?.name ?? '', position: s?.position ?? SIGNATORY_FALLBACK[role] };
    },
    scope() {
      return [['barangayId', '==', params.barangayId], ['fiscalYear', '==', params.fiscalYear]];
    },
  };

  const body = await builder.build(ctx);
  return {
    ...body,
    code: builder.code,
    title: body.title ?? def.reportName,
    agencyHeader: agencyHeaderLines(barangayName),
    paper: { size: def.paperSize, orientation: def.orientation },
    generatedAt: now.toISOString(),
  };
}
