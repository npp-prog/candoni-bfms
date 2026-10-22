import { COL } from '../constants/collections';
import type { Centavos, IsoDate, PartyRef, Ts } from '../types/common';
import type { CashAdvanceType, CheckDoc, DisbursementVoucherDoc, PayrollDoc, PayrollEntry } from '../types/treasury';
import { standardTransitions, type ModuleTransition, type SourceModuleDef } from './types';

// The phase's pure helpers live in accounting/disbursements.ts; re-exported here so the shared
// index (owned by the framework) exposes them without an edit.
export * from '../accounting/disbursements';

/**
 * Phase 5 — Disbursement vouchers (MFMB DV), checks, ADA and payroll (docs 05 §10 DV chain):
 * Treasurer encodes/submits → Committee on Appropriations certified the obligation (box B) →
 * Punong Barangay approves (DV no.) → check/ADA issued and released (or cash paid) →
 * Municipal Accounting accepts (DRAFT JCT JEV) → JEV posted → DV POSTED.
 */

export const DV_CATEGORIES: ReadonlyArray<{ value: DisbursementVoucherDoc['dvCategory']; label: string }> = [
  { value: 'REGULAR', label: 'Regular (supplies, services, other expenses)' },
  { value: 'CASH_ADVANCE', label: 'Cash advance' },
  { value: 'PAYROLL', label: 'Payroll' },
  { value: 'REIMBURSEMENT', label: 'Reimbursement' },
  { value: 'REMITTANCE', label: 'Remittance (BIR, GSIS, Pag-IBIG, PhilHealth)' },
  { value: 'TRANSFER', label: 'Fund transfer (SK, LDRRMF)' },
  { value: 'OTHER', label: 'Other' },
];

export const DV_TAX_TYPES: ReadonlyArray<{ value: 'EWT' | 'VAT' | 'PT' | 'DST' | 'OTHER'; label: string; defaultBp: number }> = [
  { value: 'EWT', label: 'Expanded withholding tax', defaultBp: 100 },
  { value: 'VAT', label: 'VAT withheld', defaultBp: 500 },
  { value: 'PT', label: 'Percentage tax withheld', defaultBp: 300 },
  { value: 'DST', label: 'Documentary stamp tax', defaultBp: 150 },
  { value: 'OTHER', label: 'Other tax', defaultBp: 100 },
];

export const DV_PAYMENT_METHODS = [
  { value: 'CHECK', label: 'Check' },
  { value: 'ADA', label: 'Advice to Debit Account (ADA)' },
  { value: 'CASH', label: 'Cash' },
] as const;
export type DvPaymentMethod = (typeof DV_PAYMENT_METHODS)[number]['value'];

export const DV_CASH_ADVANCE_TYPES: ReadonlyArray<{ value: CashAdvanceType; label: string }> = [
  { value: 'PAYROLL', label: 'Payroll' },
  { value: 'OFFICIAL_TRAVEL', label: 'Official travel' },
  { value: 'SPECIAL_PURPOSE', label: 'Special purpose / time-bound undertaking' },
  { value: 'PETTY_CASH', label: 'Petty cash fund' },
  { value: 'OTHER_AUTHORIZED', label: 'Other authorized' },
];

export const PAYROLL_TYPES: ReadonlyArray<{ value: PayrollDoc['payrollType']; label: string }> = [
  { value: 'HONORARIA', label: 'Honoraria (barangay officials)' },
  { value: 'EMPLOYEES', label: 'Salaries and wages (employees)' },
  { value: 'LABOR', label: 'Labor / job orders' },
  { value: 'ALLOWANCE', label: 'Allowances (BHW, BNS, tanod…)' },
  { value: 'OTHER', label: 'Other' },
];

export const PAYROLL_PAYMENT_METHODS: ReadonlyArray<{ value: PayrollDoc['paymentMethod']; label: string }> = [
  { value: 'CASH_ADVANCE', label: "Cash advance of the disbursing officer" },
  { value: 'CHECK', label: 'Check' },
  { value: 'ADA', label: 'ADA (bank credits to payees)' },
];

// ------------------------------------------------------------------ record shapes (extend frozen types)

/** UNPAID → ISSUED (check/ADA issued) → RELEASED (handed to payee / bank debited / cash paid). */
export type DvPaymentStatus = 'UNPAID' | 'ISSUED' | 'RELEASED';

export interface DvCashAdvanceInfo {
  /** subsidiaryAccounts id under 1-03-03-010 (AO##) or 1-03-03-020 (EO##). */
  accountableOfficerId: string;
  accountableOfficerName: string;
  accountCode: string;
  cashAdvanceType: CashAdvanceType;
  purpose: string;
}

export interface DvCancelledPayment {
  kind: 'CHECK' | 'ADA';
  id: string;
  number: string;
  status: 'CANCELLED' | 'VOID';
  reason: string;
  date: IsoDate;
}

export interface DvRecord extends DisbursementVoucherDoc {
  taxDeductions: Array<{ taxType: 'EWT' | 'VAT' | 'PT' | 'DST' | 'OTHER'; rateBp: number; base: Centavos; amount: Centavos }>;
  totalTaxes: Centavos;
  totalOtherDeductions: Centavos;
  /** Snapshot of the certified obligation (box B of the DV). */
  obligationNumber: string | null;
  appropriationId: string | null;
  /**
   * Phase 7 reads STF disbursements from DVs whose obligation names a Special Trust Fund: the
   * obligation's `specialTrustFundId` is copied here at save (authoritative value stays on the obligation).
   */
  specialTrustFundId: string | null;
  /** SL of 2-02-01-010 credited with taxes withheld (BIR01). */
  taxSubsidiaryId: string | null;
  /** Cash payments: SL under 1-01-01-010 (BT##) credited. */
  cashOfficerId: string | null;
  cashAdvance: DvCashAdvanceInfo | null;
  paymentStatus: DvPaymentStatus;
  bankAccountId: string | null;
  checkNumber: string | null;
  checkDate: IsoDate | null;
  adaId: string | null;
  adaNumber: string | null;
  /** Date cash left the barangay's books (check/ADA date, or cash release date) — the JEV date. */
  paymentDate: IsoDate | null;
  releasedDate: IsoDate | null;
  cancelledPayments: DvCancelledPayment[];
  jevNumber?: string | null;
}

export interface CheckRecord extends CheckDoc {
  dvNumber: string | null;
  natureOfPayment: string;
  /** CIB## ledger of the bank account (1-01-02-010). */
  bankSubsidiaryId: string | null;
  cancelledDate: IsoDate | null;
  cancelledBy: string | null;
}

export type AdaStatus = 'ISSUED' | 'RELEASED' | 'CANCELLED' | 'VOID';

/** adas/{id} — Advice to Debit Account (created by the DV's ISSUE_ADA action). */
export interface AdaRecord {
  barangayId: DvRecord['barangayId'];
  fiscalYear: number;
  adaNumber: string;
  adaDate: IsoDate;
  bankAccountId: string;
  bankSubsidiaryId: string | null;
  dvId: string;
  dvNumber: string | null;
  payee: PartyRef;
  natureOfPayment: string;
  amount: Centavos;
  status: AdaStatus;
  releasedDate: IsoDate | null;
  cancelReason: string | null;
  cancelledDate: IsoDate | null;
  createdAt: Ts;
  createdBy: string;
  updatedAt: Ts;
  updatedBy: string;
}

/**
 * payrolls/{id}. Entries are stored inline (cap PAYROLL_MAX_ENTRIES = 200 payees) instead of the
 * `entries` subcollection the frozen type mentions: one document keeps saves atomic and cheap.
 */
export interface PayrollRecord extends PayrollDoc {
  payrollDate: IsoDate;
  particulars: string;
  entries: PayrollEntry[];
  /** CASH_ADVANCE payrolls: SL under 1-03-03-010 (AO##) of the disbursing officer. */
  disbursingOfficerId: string | null;
  disbursingOfficerName: string | null;
  obligationNumber: string | null;
  dvNumber?: string | null;
}

// ------------------------------------------------------------------ module definitions

/** DV payment actions (rendered by the payment panel, not the generic ActionBar). */
export const DV_PAYMENT_ACTIONS = ['ISSUE_CHECK', 'ISSUE_ADA', 'RELEASE', 'CANCEL_PAYMENT'] as const;

const dvPayment: ModuleTransition[] = [
  { action: 'ISSUE_CHECK', label: 'Issue check', from: ['APPROVED'], to: 'APPROVED', permission: 'treasury.submit', tone: 'primary', auditAction: 'ISSUE' },
  { action: 'ISSUE_ADA', label: 'Issue ADA', from: ['APPROVED'], to: 'APPROVED', permission: 'treasury.submit', tone: 'primary', auditAction: 'ISSUE' },
  { action: 'RELEASE', label: 'Release payment', from: ['APPROVED'], to: 'APPROVED', permission: 'treasury.submit', tone: 'primary', auditAction: 'RELEASE' },
  { action: 'CANCEL_PAYMENT', label: 'Cancel check / ADA…', from: ['APPROVED'], to: 'APPROVED', permission: 'treasury.submit', requiresReason: true, tone: 'danger', auditAction: 'CANCEL', confirm: 'The check / ADA keeps its number with status CANCELLED and a new one can be issued.' },
];

export const DV_MODULE: SourceModuleDef = {
  key: 'disbursementVoucher',
  collection: COL.disbursementVouchers,
  label: 'Disbursement voucher',
  dateField: 'dvDate',
  numberField: 'dvNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  jevSource: 'DV',
  transitions: [
    ...standardTransitions({ approve: true, accept: true }).map((t) =>
      t.action === 'APPROVE'
        ? { ...t, confirm: 'Approving assigns the DV number and links the certified obligation. A cash-advance DV also opens the cash advance of the accountable officer.' }
        : t.action === 'ACCEPT'
          ? { ...t, confirm: 'Accepting creates the DRAFT JCT entry (Dr charges / Cr cash, taxes withheld) for Municipal Accounting to approve and post.' }
          : t,
    ),
    ...dvPayment,
  ],
};

export const PAYROLL_MODULE: SourceModuleDef = {
  key: 'payroll',
  collection: COL.payrolls,
  label: 'Payroll',
  dateField: 'payrollDate',
  numberField: 'payrollNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit for approval', from: ['DRAFT'], to: 'SUBMITTED', permission: 'treasury.submit', tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'RESUBMITTED', permission: 'treasury.submit', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'APPROVE', label: 'Approve', from: ['SUBMITTED', 'RESUBMITTED'], to: 'APPROVED', permission: 'transaction.approve', segregation: true, tone: 'primary', confirm: 'Approving assigns the payroll number. The treasurer then prepares the DV from it.' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED', 'RESUBMITTED'], to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'treasury.encode', requiresReason: true, tone: 'danger' },
    { action: 'VOID', label: 'Void…', from: ['SUBMITTED', 'RESUBMITTED', 'APPROVED'], to: 'VOID', permission: 'transaction.approve', requiresReason: true, tone: 'danger' },
  ],
};

export const DISBURSEMENTS_MODULES: SourceModuleDef[] = [DV_MODULE, PAYROLL_MODULE];
