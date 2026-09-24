export const FISCAL_YEAR_STATUSES = ['SETUP', 'OPEN', 'CLOSING', 'CLOSED'] as const;
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];

export const PERIOD_STATUSES = ['OPEN', 'REVIEW', 'LOCKED', 'CLOSED'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/** Common workflow statuses (Section LXXIV). Not every module uses every status. */
export const WORKFLOW_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'FOR_REVIEW',
  'RETURNED',
  'RESUBMITTED',
  'APPROVED',
  'ACCEPTED',
  'POSTED',
  'VOID',
  'CLOSED',
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** Statuses in which a barangay user may edit a source document from the client. */
export const CLIENT_EDITABLE_STATUSES: readonly WorkflowStatus[] = ['DRAFT', 'RETURNED'];

/** Statuses visible to the Auditor / read-only role. */
export const AUDITOR_VISIBLE_STATUSES: readonly WorkflowStatus[] = [
  'SUBMITTED',
  'FOR_REVIEW',
  'RESUBMITTED',
  'APPROVED',
  'ACCEPTED',
  'POSTED',
  'CLOSED',
];

export const JEV_STATUSES = ['DRAFT', 'FOR_REVIEW', 'RETURNED', 'APPROVED', 'POSTED', 'REVERSED'] as const;
export type JevStatus = (typeof JEV_STATUSES)[number];

export const CHECK_STATUSES = [
  'PREPARED',
  'ISSUED',
  'RELEASED',
  'CLEARED',
  'OUTSTANDING',
  'CANCELLED',
  'VOID',
  'STALE',
] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const CASH_ADVANCE_STATUSES = [
  'ACTIVE',
  'PARTIALLY_LIQUIDATED',
  'FULLY_LIQUIDATED',
  'OVERDUE',
  'CLOSED',
] as const;
export type CashAdvanceStatus = (typeof CASH_ADVANCE_STATUSES)[number];

export const REPORT_STATUSES = [
  'DRAFT',
  'GENERATED',
  'FOR_REVIEW',
  'SUBMITTED',
  'RETURNED',
  'RESUBMITTED',
  'ACCEPTED',
  'FINAL',
  'ARCHIVED',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const COMPLIANCE_STATUSES = [
  'NOT_STARTED',
  'DRAFT',
  'GENERATED',
  'SUBMITTED',
  'FOR_REVIEW',
  'RETURNED',
  'RESUBMITTED',
  'ACCEPTED',
  'OVERDUE',
  'NOT_APPLICABLE',
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const PACKAGE_ITEM_STATUSES = [
  'REQUIRED',
  'GENERATED',
  'MISSING',
  'FOR_REVIEW',
  'RETURNED',
  'ACCEPTED',
  'NOT_APPLICABLE',
] as const;
export type PackageItemStatus = (typeof PACKAGE_ITEM_STATUSES)[number];

export const VALIDATION_RESULTS = ['PASSED', 'WARNING', 'FAILED'] as const;
export type ValidationResult = (typeof VALIDATION_RESULTS)[number];

export const ATTACHMENT_REVIEW_STATUSES = ['COMPLETE', 'INCOMPLETE', 'FOR_REPLACEMENT', 'NOT_APPLICABLE'] as const;
export type AttachmentReviewStatus = (typeof ATTACHMENT_REVIEW_STATUSES)[number];
