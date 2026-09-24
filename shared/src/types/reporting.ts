import type { RoleCode } from '../security/roles';
import type { ComplianceStatus, ReportStatus, ValidationResult } from '../constants/statuses';
import type { BarangayId, PeriodKey, Ts } from './common';

export type ReportCategory =
  | 'BOOKS'
  | 'BUDGET'
  | 'COLLECTIONS_DEPOSITS'
  | 'DISBURSEMENTS'
  | 'CASH_ADVANCES'
  | 'PETTY_CASH'
  | 'ACCOUNTABLE_FORMS'
  | 'BANK'
  | 'PROPERTY'
  | 'REGISTRIES'
  | 'FINANCIAL_STATEMENTS'
  | 'SCHEDULES'
  | 'COMPLIANCE';

export type ReportFrequency = 'ON_DEMAND' | 'PER_TRANSACTION' | 'DAILY' | 'MONTHLY' | 'QUARTERLY' | 'SEMESTRAL' | 'ANNUAL';

export type ResponsibleOffice = 'BARANGAY_TREASURER' | 'COMMITTEE_ON_APPROPRIATIONS' | 'PUNONG_BARANGAY' | 'PROPERTY_OFFICE' | 'MUNICIPAL_ACCOUNTING' | 'BAC_OR_PROCUREMENT' | 'INSPECTION_COMMITTEE';

/** Deadline rule DSL (evaluated by shared/compliance): */
export type DeadlineRule =
  | { kind: 'DAYS_AFTER_PERIOD_END'; days: number; businessDays?: boolean }
  | { kind: 'DAY_OF_FOLLOWING_MONTH'; day: number }
  | { kind: 'FIXED_DATE_NEXT_YEAR'; month: number; day: number }
  | { kind: 'DAYS_AFTER_EVENT'; days: number; event: string }
  | { kind: 'NONE' };

/** reportDefinitions/{reportCode} */
export interface ReportDefinition {
  reportCode: string;
  formNumber: number | null; // 1–50 per master prompt §LII
  reportName: string;
  category: ReportCategory;
  responsibleOffice: ResponsibleOffice;
  preparedByRole: RoleCode;
  certifiedByRole: RoleCode | null;
  approvedByRole: RoleCode | null;
  frequency: ReportFrequency;
  deadlineRule: DeadlineRule;
  sourceCollections: string[];
  requiredFields: string[];
  paperSize: 'A4' | 'LEGAL' | 'LETTER';
  orientation: 'PORTRAIT' | 'LANDSCAPE';
  templateVersion: number;
  inMonthlyPackage: boolean;
  generation: 'AUTO' | 'FORM' | 'HYBRID'; // AUTO = fully derived; FORM = printable form from one record
  validations: string[]; // validator ids (see reports/validators)
  phase: number;
  active: boolean;
}

/** generatedReports/{id} — immutable once FINAL; new version for revisions. */
export interface GeneratedReportDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  reportCode: string;
  reportingPeriod: { type: 'MONTH' | 'QUARTER' | 'YEAR' | 'RANGE' | 'AS_OF'; from: string; to: string; label: string };
  filters: Record<string, string | number | null>;
  version: number;
  status: ReportStatus;
  templateVersion: number;
  dataHash: string; // sha256 of canonical payload
  payloadPath: string; // Storage JSON snapshot
  storageFilePath: { pdf?: string; xlsx?: string };
  validation: Array<{ id: string; result: ValidationResult; message: string }>;
  signatories: Record<string, { name: string; position: string }>;
  generatedBy: string;
  generatedAt: Ts;
  submittedBy: string | null;
  submittedAt: Ts | null;
  reviewedBy: string | null;
  reviewedAt: Ts | null;
  acceptedBy: string | null;
  acceptedAt: Ts | null;
  finalizedBy: string | null;
  finalizedAt: Ts | null;
  sourceDataCutoff: Ts;
  supersedesReportId: string | null;
  staleSource: boolean;
}

/** reportMappings/{id} */
export interface ReportMappingDoc {
  accountCode: string; // exact or prefix ending with '*'
  statement: 'SFP' | 'SFPERF' | 'SCNA' | 'SCF' | 'SCBAA';
  section: string;
  lineItem: string; // e.g. 'SFP.CA.CASH'
  sortOrder: number;
  signMultiplier: 1 | -1;
  cashFlowClassification: 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NON_CASH' | null;
  effectiveFromYear: number;
  active: boolean;
}

/** complianceRequirements/{id} */
export interface ComplianceRequirementDoc {
  reportCode: string;
  frequency: ReportFrequency;
  deadlineRule: DeadlineRule;
  responsibleRole: RoleCode;
  appliesTo: BarangayId[] | 'ALL';
  effectiveFrom: PeriodKey;
  effectiveTo: PeriodKey | null;
  active: boolean;
}

/** reportSubmissions/{bid}_{fy}_{period}_{reportCode} — compliance matrix cell */
export interface ReportSubmissionDoc {
  barangayId: BarangayId;
  fiscalYear: number;
  period: PeriodKey;
  reportCode: string;
  status: ComplianceStatus;
  dueDate: string;
  generatedReportId: string | null;
  lastActionAt: Ts;
  lastActionBy: string | null;
}
