import { COL } from '../constants/collections';
import type { Centavos, FundId, IsoDate, PeriodScoped, WorkflowTracked } from '../types/common';
import type { AccountableFormDoc, CollectionDoc, DepositDoc, PaymentMethod, RcdDoc } from '../types/treasury';
import { standardTransitions, type SourceModuleDef } from './types';

export * from '../accounting/collections';

/**
 * Phase 4 — collections, deposits, RCD/RCR and accountable forms (MFMB: Official Receipts AF 51,
 * Report of Collections and Deposits, Report of Collections and Remittances, RAAF, Cashbook).
 *
 * STATUS FLOW OF AN OFFICIAL RECEIPT (collections) — encoding is immediate for the treasurer:
 *   issueOfficialReceipt ─► DRAFT ("Issued": the pre-printed number is consumed at once; payor,
 *                           lines and date stay correctable until the OR is reported)
 *   DRAFT ─CANCEL (reason)─► CANCELLED (spoiled OR: the number is kept and accounted for in the RAAF)
 *   DRAFT ─(RCR submitted)─► SUBMITTED (deputized collector remitted it to the treasurer)
 *   DRAFT ─(RCD submitted)─► SUBMITTED ─(RCD accepted)─► ACCEPTED   (RCD returned/voided → back to DRAFT)
 * The RCD carries the workflow and the single JCT JEV; posting that JEV stamps the RCD POSTED.
 * An OR counts as an official collection unless it is VOID or CANCELLED (REAI and cashbooks).
 *
 * Deposits are DRAFT until reported in an RCD (then SUBMITTED → ACCEPTED like the ORs); VOID releases
 * their ORs. Accountable forms are server-only (`accountableForms` is read-only to clients).
 */

export const AF_FORM_TYPES: ReadonlyArray<{ value: AccountableFormDoc['formType']; label: string }> = [
  { value: 'AF51', label: 'AF 51 — Official Receipt' },
  { value: 'AF52', label: 'AF 52 — Cash Ticket' },
  { value: 'AF53', label: 'AF 53 — Official Receipt (Marking Fees)' },
  { value: 'AF56', label: 'AF 56 — Official Receipt (Real Property Tax)' },
  { value: 'CTC', label: 'Community Tax Certificate' },
  { value: 'OTHER', label: 'Other accountable form' },
];
export const afFormLabel = (v: string) => AF_FORM_TYPES.find((f) => f.value === v)?.label ?? v;

export const PAYMENT_METHODS: ReadonlyArray<{ value: PaymentMethod; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CHECK', label: 'Check' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'ADA', label: 'ADA' },
  { value: 'OTHER', label: 'Other' },
];

export const CASHBOOK_VARIANTS = [
  { value: 'CASH_IN_TREASURY', label: 'Cash in Local Treasury (collections / deposits)' },
  { value: 'CASH_IN_BANK', label: 'Cash in Bank (deposits / checks & ADA)' },
] as const;

/** GL accounts of the cash accountabilities (docs 04 §9). */
export const CASHBOOK_ACCOUNTS = { CASH_IN_TREASURY: '1-01-01-010', CASH_IN_BANK: '1-01-02-010' } as const;

/** Display label of the status of an OR (DRAFT means issued and not yet reported). */
export function collectionStatusLabel(status: string): string {
  return status === 'DRAFT' ? 'ISSUED' : status;
}

// ------------------------------------------------------------------ extended document shapes

/** collections/{id} as stored by Phase 4 (CollectionDoc + denormalized fields). */
export interface CollectionRecord extends CollectionDoc {
  serialNumber: number;
  accountableFormType: AccountableFormDoc['formType'];
  collectingOfficerName: string;
  /** RCR that remitted this OR to the treasurer (deputized collectors). */
  rcrId: string | null;
}

/** deposits/{id} as stored by Phase 4. */
export interface DepositRecord extends DepositDoc {
  depositNumber: string | null; // DEP-YYYY-MM-NNN (server, at creation)
  /** Accountable officer (BT##) whose cash was deposited; the RCD groups deposits by it. */
  accountableOfficerId: string;
  bankLabel: string;
}

export interface RcdRecord extends RcdDoc {
  accountableOfficerName: string;
  rcrIds: string[];
  undepositedBeginning: Centavos;
  collectionCount: number;
  cancelledCount: number;
  orFrom: string | null;
  orTo: string | null;
  validationResult: 'PASSED' | 'WARNING' | 'FAILED';
  validationMessage: string;
}

/** rcrReports/{id} — Report of Collections and Remittances (deputized collector → treasurer). */
export interface RcrDoc extends PeriodScoped, WorkflowTracked<'DRAFT' | 'SUBMITTED' | 'RESUBMITTED' | 'RETURNED' | 'ACCEPTED' | 'VOID'> {
  rcrNumber: string | null;
  fundId: FundId;
  collectorId: string; // SL under 1-01-01-010 of the deputized collector
  collectorName: string;
  receivingOfficerId: string; // the treasurer's SL (BT##)
  receivingOfficerName: string;
  dateFrom: IsoDate;
  dateTo: IsoDate;
  remittanceDate: IsoDate;
  collectionIds: string[];
  collectionCount: number;
  totalCollections: Centavos;
  amountRemitted: Centavos;
  orFrom: string | null;
  orTo: string | null;
  rcdId: string | null;
}

export interface AccountableFormRecord extends AccountableFormDoc {
  accountableOfficerName: string | null;
  /** Digits printed on the form (zero padding). */
  serialWidth: number;
  remarks: string;
}

// ------------------------------------------------------------------ source modules

export const COLLECTION_MODULE: SourceModuleDef = {
  key: 'collection',
  collection: COL.collections,
  label: 'Official receipt',
  dateField: 'collectionDate',
  numberField: 'officialReceiptNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT'],
  transitions: [
    { action: 'CANCEL', label: 'Cancel OR (spoiled)…', from: ['DRAFT'], to: 'CANCELLED', permission: 'treasury.encode', requiresReason: true, tone: 'danger', confirm: 'The OR number stays used and is reported as cancelled in the RAAF. Keep the spoiled original with its duplicates.' },
  ],
};

export const DEPOSIT_MODULE: SourceModuleDef = {
  key: 'deposit',
  collection: COL.deposits,
  label: 'Deposit',
  dateField: 'depositDate',
  numberField: 'depositNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT'],
  transitions: [
    { action: 'VOID', label: 'Void deposit…', from: ['DRAFT'], to: 'VOID', permission: 'treasury.encode', requiresReason: true, tone: 'danger', confirm: 'Voiding releases the official receipts so they can be deposited on another slip.' },
  ],
};

export const RCD_MODULE: SourceModuleDef = {
  key: 'rcd',
  collection: COL.rcdReports,
  label: 'RCD',
  dateField: 'dateTo',
  numberField: 'rcdNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  jevSource: 'RCD',
  transitions: standardTransitions({ accept: true }).map((t) =>
    t.action === 'SUBMIT' ? { ...t, label: 'Submit RCD', confirm: 'Submitting assigns the RCD number and locks the listed ORs and deposits until accounting accepts or returns the report.' } : t,
  ),
};

export const RCR_MODULE: SourceModuleDef = {
  key: 'rcr',
  collection: COL.rcrReports,
  label: 'RCR',
  dateField: 'remittanceDate',
  numberField: 'rcrNumber',
  encodePermission: 'treasury.encode',
  editableStatuses: ['DRAFT', 'RETURNED'],
  transitions: [
    { action: 'SUBMIT', label: 'Submit remittance', from: ['DRAFT'], to: 'SUBMITTED', permission: 'treasury.encode', tone: 'primary', confirm: 'Submitting assigns the RCR number and locks the listed ORs.' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'RESUBMITTED', permission: 'treasury.encode', tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'ACCEPT', label: 'Acknowledge receipt', from: ['SUBMITTED', 'RESUBMITTED'], to: 'ACCEPTED', permission: 'treasury.submit', tone: 'primary', confirm: 'The treasurer acknowledges receiving the remitted cash; it will be reported in the treasurer\'s next RCD.' },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED', 'RESUBMITTED'], to: 'RETURNED', permission: 'treasury.submit', requiresReason: true, tone: 'secondary' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'treasury.encode', requiresReason: true, tone: 'danger' },
  ],
};

export const COLLECTIONS_MODULES: SourceModuleDef[] = [COLLECTION_MODULE, DEPOSIT_MODULE, RCD_MODULE, RCR_MODULE];
