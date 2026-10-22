import { COL } from '../constants/collections';
import type { CashAdvanceType, CashAdvanceDoc, LiquidationDoc, LiquidationItem, PettyCashFundDoc, PettyCashTransactionDoc, SpecialTrustFundDoc } from '../types/treasury';
import type { Centavos, IsoDate } from '../types/common';
import type { StfHistoryEntry } from '../accounting/cashAdvancesLedger';
import { standardTransitions, type SourceModuleDef } from './types';

export * from '../accounting/cashAdvancesLedger';

/**
 * Phases 6–7 — cash advances (created by Phase 5 from an approved CASH_ADVANCE DV, or migrated as
 * LEGACY by accounting), Liquidation Reports, petty cash (fund, PCVs, replenishment) and Special
 * Trust Funds (docs 05 §10, MFMB Sections XXXI–XXXV).
 */

export const CASH_ADVANCE_TYPES: ReadonlyArray<{ value: CashAdvanceType; label: string; accountCode: '1-03-03-010' | '1-03-03-020' }> = [
  { value: 'PAYROLL', label: 'Payroll', accountCode: '1-03-03-010' },
  { value: 'OFFICIAL_TRAVEL', label: 'Official travel', accountCode: '1-03-03-020' },
  { value: 'SPECIAL_PURPOSE', label: 'Special purpose / time-bound undertaking', accountCode: '1-03-03-020' },
  { value: 'PETTY_CASH', label: 'Petty cash fund', accountCode: '1-03-03-020' },
  { value: 'OTHER_AUTHORIZED', label: 'Other authorized', accountCode: '1-03-03-020' },
];
export const CA_ACCOUNTS = [
  { value: '1-03-03-010', label: '1-03-03-010 Advances for Payroll (AO##)' },
  { value: '1-03-03-020', label: '1-03-03-020 Advances to Officers and Employees (EO##)' },
] as const;
export const caTypeLabel = (t: string) => CASH_ADVANCE_TYPES.find((x) => x.value === t)?.label ?? t;

/** cashAdvances/{id} as stored by this phase (legacy fields are absent on DV-created advances). */
export interface CashAdvanceRecord extends CashAdvanceDoc {
  fundId?: string;
  /** Liquidated before migration (legacy advances only); part of amountLiquidated. */
  openingLiquidated?: Centavos;
  lastLiquidationId?: string | null;
  agingAsOf?: IsoDate;
}

/** liquidations/{id}: the items are stored in the document (≤ LIQUIDATION_MAX_ITEMS). */
export interface LiquidationRecord extends LiquidationDoc {
  items: LiquidationItem[];
  accountableOfficerName: string;
  caAccountCode: string;
  caDvNumber: string;
  caGrantDate: IsoDate;
  caPurpose: string;
  /** Outstanding balance of the cash advance when this report was saved/accepted. */
  outstandingBefore: Centavos;
  refundOrDate: IsoDate | null;
  refundCashSubsidiaryId: string | null;
  remarks: string;
}
export const LIQUIDATION_MAX_ITEMS = 150;

export interface PettyCashFundRecord extends PettyCashFundDoc {
  fundName: string;
  custodianName: string;
  custodianCode: string;
  establishedDvNumber: string;
  dateEstablished: IsoDate;
  closedDate?: IsoDate | null;
  createdAt?: unknown;
}

export interface PettyCashTxnRecord extends PettyCashTransactionDoc {
  custodianId?: string;
  /** PAYMENT: replenishment request it is included in (set at submit of the request). */
  replenishmentId?: string | null;
  /** REPLENISH: the PCVs it replenishes and its number (PCR-YYYY-MM-NNN). */
  pcvIds?: string[];
  replenishmentNumber?: string | null;
  replenishmentDvNumber?: string | null;
  replenishedDate?: IsoDate | null;
  /** RETURN / YEAR_END_CLOSE: OR issued for the returned cash. */
  refundOrNumber?: string | null;
}

export interface SpecialTrustFundRecord extends SpecialTrustFundDoc {
  subsidiaryId: string;
  history: StfHistoryEntry[];
  bankAccountId?: string | null;
  jevId?: string | null;
}

export const LIQUIDATION_MODULE: SourceModuleDef = {
  key: 'liquidation',
  collection: COL.liquidations,
  label: 'Liquidation report',
  dateField: 'liquidationDate',
  numberField: 'liquidationNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: standardTransitions({ approve: true, accept: true }).map((t) =>
    t.action === 'SUBMIT' ? { ...t, confirm: 'Submitting assigns the LR number and sends the report to the Punong Barangay for approval.' }
    : t.action === 'ACCEPT' ? { ...t, confirm: 'Accepting applies the liquidation to the cash advance and creates a DRAFT General Journal entry for posting.' }
    : t),
  jevSource: 'LIQUIDATION',
};

export const PETTY_CASH_VOUCHER_MODULE: SourceModuleDef = {
  key: 'pettyCashVoucher',
  collection: COL.pettyCashTransactions,
  label: 'Petty cash voucher',
  dateField: 'date',
  numberField: 'pcvNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit for approval', from: ['DRAFT'], to: 'SUBMITTED', permission: 'treasury.submit', tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'RESUBMITTED', permission: 'treasury.submit', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'APPROVE', label: 'Approve & pay', from: ['SUBMITTED', 'RESUBMITTED'], to: 'APPROVED', permission: 'transaction.approve', segregation: true, tone: 'primary', confirm: 'Approval assigns the PCV number and pays the amount out of the petty cash on hand.' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED', 'RESUBMITTED'], to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'treasury.encode', requiresReason: true, tone: 'danger' },
    { action: 'VOID', label: 'Void…', from: ['SUBMITTED', 'RESUBMITTED'], to: 'VOID', permission: 'treasury.submit', requiresReason: true, tone: 'danger' },
    { action: 'VOID', label: 'Cancel payment…', from: ['APPROVED'], to: 'VOID', permission: 'transaction.approve', requiresReason: true, tone: 'danger', confirm: 'Only an unreplenished PCV can be cancelled; the amount goes back to the petty cash on hand.' },
  ],
};

export const PETTY_CASH_REPLENISHMENT_MODULE: SourceModuleDef = {
  key: 'pettyCashReplenishment',
  collection: COL.pettyCashTransactions,
  label: 'Petty cash replenishment',
  dateField: 'date',
  numberField: 'replenishmentNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit request', from: ['DRAFT'], to: 'SUBMITTED', permission: 'treasury.submit', tone: 'primary', confirm: 'Submitting includes every paid, unreplenished PCV of the fund and assigns the request number.' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'RESUBMITTED', permission: 'treasury.submit', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'APPROVE', label: 'Approve', from: ['SUBMITTED', 'RESUBMITTED'], to: 'APPROVED', permission: 'transaction.approve', segregation: true, tone: 'primary' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED', 'RESUBMITTED'], to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    { action: 'REPLENISH', label: 'Record replenishment DV', from: ['APPROVED'], to: 'ACCEPTED', permission: 'treasury.encode', tone: 'primary', auditAction: 'EDIT', confirm: 'Record the DV that replenished the fund. The cash on hand is restored and the PCVs are marked replenished.' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'treasury.encode', requiresReason: true, tone: 'danger' },
    { action: 'VOID', label: 'Void…', from: ['SUBMITTED', 'RESUBMITTED', 'APPROVED'], to: 'VOID', permission: 'treasury.submit', requiresReason: true, tone: 'danger' },
  ],
};

export const CASH_ADVANCES_MODULES: SourceModuleDef[] = [LIQUIDATION_MODULE, PETTY_CASH_VOUCHER_MODULE, PETTY_CASH_REPLENISHMENT_MODULE];
