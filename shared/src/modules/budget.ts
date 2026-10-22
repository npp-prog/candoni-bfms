import { COL } from '../constants/collections';
import type { AppropriationClass, ExpenseClass } from '../types/budget';
import type { SourceModuleDef } from './types';

/**
 * Phase 3 — Budget (docs 05 §10 "Certify obligation"): appropriations per Appropriation Ordinance,
 * supplemental/realignment/augmentation adjustments, and obligation requests (OBR) certified by
 * the Committee on Appropriations against the available balance.
 */

export const APPROPRIATION_CLASSES: ReadonlyArray<{ value: AppropriationClass; label: string }> = [
  { value: 'REGULAR', label: 'Regular' },
  { value: 'SK_10PCT', label: 'SK Fund (10%)' },
  { value: 'LDRRMF_5PCT', label: 'LDRRMF (5%)' },
  { value: 'DF_20PCT', label: '20% Development Fund' },
  { value: 'CONTINUING', label: 'Continuing appropriations' },
  { value: 'OTHER', label: 'Other' },
];

export const EXPENSE_CLASSES: ReadonlyArray<{ value: ExpenseClass; label: string }> = [
  { value: 'PS', label: 'Personal Services' },
  { value: 'MOOE', label: 'Maintenance and Other Operating Expenses' },
  { value: 'FE', label: 'Financial Expenses' },
  { value: 'CO', label: 'Capital Outlay' },
];

export const ADJUSTMENT_TYPES = [
  { value: 'SUPPLEMENTAL', label: 'Supplemental appropriation', sign: 1 },
  { value: 'AUGMENTATION', label: 'Augmentation', sign: 1 },
  { value: 'REALIGNMENT_IN', label: 'Realignment (to this item)', sign: 1 },
  { value: 'REALIGNMENT_OUT', label: 'Realignment (from this item)', sign: -1 },
  { value: 'OTHER', label: 'Other adjustment (reduction)', sign: -1 },
] as const;

/** Default expense class from the account code (5-01 PS, 5-02/5-99 MOOE, 5-03 FE, 1-07/1-06/1-08 CO). */
export function expenseClassOf(accountCode: string): ExpenseClass {
  if (accountCode.startsWith('5-01')) return 'PS';
  if (accountCode.startsWith('5-03')) return 'FE';
  if (/^1-0[678]/.test(accountCode)) return 'CO';
  return 'MOOE';
}

export const APPROPRIATION_MODULE: SourceModuleDef = {
  key: 'appropriation',
  collection: COL.appropriations,
  label: 'Appropriation',
  dateField: 'appropriationOrdinanceDate',
  encodePermission: 'budget.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit for approval', from: ['DRAFT'], to: 'SUBMITTED', permission: 'budget.encode', tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'SUBMITTED', permission: 'budget.encode', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'APPROVE', label: 'Approve (activate)', from: ['SUBMITTED'], to: 'ACTIVE', permission: 'transaction.approve', segregation: true, tone: 'primary', confirm: 'An active appropriation can be charged by obligations. Later changes need an ordinance adjustment.' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED'], to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'budget.encode', requiresReason: true, tone: 'danger' },
  ],
};

export const APPROPRIATION_ADJUSTMENT_MODULE: SourceModuleDef = {
  key: 'appropriationAdjustment',
  collection: COL.appropriationAdjustments,
  label: 'Appropriation adjustment',
  dateField: 'ordinanceDate',
  encodePermission: 'budget.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit for approval', from: ['DRAFT'], to: 'SUBMITTED', permission: 'budget.encode', tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'SUBMITTED', permission: 'budget.encode', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'APPROVE', label: 'Approve & apply', from: ['SUBMITTED'], to: 'APPROVED', permission: 'transaction.approve', segregation: true, tone: 'primary', confirm: 'The adjustment is applied to the appropriation and recorded in the RAO.' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED'], to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'budget.encode', requiresReason: true, tone: 'danger' },
  ],
};

export const OBLIGATION_MODULE: SourceModuleDef = {
  key: 'obligation',
  collection: COL.obligations,
  label: 'Obligation request',
  dateField: 'date',
  numberField: 'obligationNumber',
  encodePermission: 'obligation.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit for certification', from: ['DRAFT'], to: 'SUBMITTED', permission: 'obligation.encode', tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'SUBMITTED', permission: 'obligation.encode', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'CERTIFY', label: 'Certify appropriation available', from: ['SUBMITTED'], to: 'CERTIFIED', permission: 'budget.certify', tone: 'primary', confirm: 'Certifying assigns the OBR number, charges the appropriation and writes the RAO line.' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED'], to: 'RETURNED', permission: 'budget.certify', requiresReason: true, tone: 'secondary' },
    { action: 'CANCEL', label: 'Cancel obligation…', from: ['CERTIFIED'], to: 'CANCELLED', permission: 'budget.certify', requiresReason: true, tone: 'danger', confirm: 'Cancelling releases the amount back to the appropriation and records a reversing RAO line.' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'obligation.encode', requiresReason: true, tone: 'danger' },
  ],
};

export const BUDGET_MODULES: SourceModuleDef[] = [APPROPRIATION_MODULE, APPROPRIATION_ADJUSTMENT_MODULE, OBLIGATION_MODULE];
