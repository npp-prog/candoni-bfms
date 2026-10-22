import { COL } from '../constants/collections';
import type { Permission } from '../security/permissions';
import type { BarangayScoped, Centavos, IsoDate, PartyRef, Tracked, Ts, WorkflowTracked } from '../types/common';
import type { InventoryItemDoc, InventoryTransactionDoc, PpeDoc } from '../types/property';
import type { ModuleTransition, SourceModuleDef } from './types';

export * from '../accounting/property';

/**
 * Phase 10 — Property, plant and equipment, supplies inventory, property documents and biological
 * assets (MFMB annexes on supplies and property). The Property Officer (`property.manage`) encodes,
 * the Punong Barangay (`transaction.approve`) approves/issues, and Municipal Accounting (`jev.prepare`)
 * runs the monthly depreciation, which generates a DRAFT GJ entry.
 */

/** Collections this phase adds beside the ones in COL (they need read rules like other source docs). */
export const PROPERTY_COL = {
  purchaseRequests: 'purchaseRequests',
  purchaseOrders: 'purchaseOrders',
  /** IAR (purchases) and ARDSM (donations): receipts that post stock and create PPE on acceptance. */
  inspectionReports: 'inspectionReports',
  /** RIS. */
  requisitions: 'requisitions',
  depreciationRuns: 'depreciationRuns',
} as const;

// ------------------------------------------------------------------ extended document types

export interface PropertySigner {
  name: string;
  position?: string;
  office?: string;
}

export interface PrLine {
  itemId: string | null;
  stockNumber: string;
  unit: string;
  description: string;
  quantity: number;
  estimatedUnitCost: Centavos;
  estimatedCost: Centavos; // server
}

export interface PurchaseRequestDoc extends BarangayScoped, WorkflowTracked<string> {
  prNumber: string | null;
  prDate: IsoDate;
  office: string;
  responsibilityCenterCode: string;
  fundId: string;
  purpose: string;
  requestedBy: PropertySigner;
  lines: PrLine[];
  totalEstimatedCost: Centavos; // server
}

export interface PoLine {
  prLineNo: number | null;
  itemId: string | null;
  stockNumber: string;
  unit: string;
  description: string;
  quantity: number;
  unitCost: Centavos;
  amount: Centavos; // server
  quantityReceived: number; // server (accepted IARs)
}

export interface PurchaseOrderDoc extends BarangayScoped, WorkflowTracked<string> {
  poNumber: string | null;
  poDate: IsoDate;
  purchaseRequestId: string;
  prNumber: string | null;
  supplier: PartyRef;
  modeOfProcurement: string;
  placeOfDelivery: string;
  dateOfDelivery: IsoDate | null;
  deliveryTerm: string;
  paymentTerm: string;
  fundId: string;
  lines: PoLine[];
  totalAmount: Centavos; // server
  deliveryStatus: 'PENDING' | 'PARTIAL' | 'COMPLETE'; // server
}

export type ReceiptLineKind = 'SUPPLY' | 'PPE';

export interface ReceiptLine {
  poLineNo: number | null;
  kind: ReceiptLineKind;
  itemId: string | null;
  stockNumber: string;
  description: string;
  unit: string;
  quantity: number;
  unitCost: Centavos;
  amount: Centavos; // server
  /** For PPE lines: classification and custody of the assets created on acceptance. */
  ppe: { accountCode: string; usefulLifeYears: number; residualValue: Centavos | null; location: string; accountablePerson: string } | null;
  /** Server, after acceptance: PPE created (one per unit). */
  ppeIds?: string[];
  propertyNumbers?: string[];
}

export interface InspectionReportDoc extends BarangayScoped, WorkflowTracked<string> {
  receiptType: 'PURCHASE' | 'DONATION';
  documentNumber: string | null; // IAR-… or ARDSM-…
  iarDate: IsoDate;
  purchaseOrderId: string | null;
  poNumber: string | null;
  supplier: PartyRef; // supplier, or donor for ARDSM
  invoiceNumber: string;
  invoiceDate: IsoDate | null;
  requisitioningOffice: string;
  inspectionDate: IsoDate | null;
  inspectedBy: string;
  fundId: string;
  remarks: string;
  lines: ReceiptLine[];
  totalAmount: Centavos; // server
}

export interface RisLine {
  itemId: string;
  stockNumber: string;
  description: string;
  unit: string;
  quantityRequested: number;
  stockAvailable: boolean; // server, at save
  quantityIssued: number; // server, at issue
  unitCost: Centavos; // server, at issue (moving average)
  amount: Centavos; // server, at issue
  remarks: string;
}

export interface RequisitionDoc extends BarangayScoped, WorkflowTracked<string> {
  risNumber: string | null;
  risDate: IsoDate;
  issueDate: IsoDate | null; // server
  office: string;
  responsibilityCenterCode: string;
  purpose: string;
  requestedBy: PropertySigner;
  receivedBy: PropertySigner;
  lines: RisLine[];
  totalIssuedCost: Centavos; // server
}

export type PropertyDocumentType = 'ICS' | 'PAR' | 'PTR' | 'RRPE' | 'IIRUP';

/** One line of an ICS (semi-expendable stock item) or of a PAR/PTR/RRPE/IIRUP (a PPE record). */
export interface PropertyDocLine {
  ppeId: string | null;
  itemId: string | null;
  propertyNumber: string;
  description: string;
  unit: string;
  quantity: number;
  unitCost: Centavos;
  amount: Centavos;
  acquisitionDate: IsoDate | null;
  estimatedUsefulLife: number | null;
  /** RRPE: condition on return; IIRUP: disposal mode / appraisal. */
  condition?: string;
  disposalMode?: 'SALE' | 'TRANSFER' | 'DESTRUCTION' | 'OTHERS';
  appraisedValue?: Centavos;
  accumulatedDepreciation?: Centavos;
  carryingAmount?: Centavos;
  remarks: string;
}

export interface PropertyDocumentDoc extends BarangayScoped, WorkflowTracked<string> {
  documentType: PropertyDocumentType;
  documentNumber: string | null;
  date: IsoDate;
  /** ICS/PAR: the end user; PTR: the new accountable officer; RRPE: who returns the property. */
  receivedBy: PropertySigner;
  /** PTR: previous accountable officer(s); RRPE/IIRUP: accountable officer. */
  fromAccountable: string;
  toLocation: string;
  transferType: string;
  reason: string;
  remarks: string;
  lines: PropertyDocLine[];
  totalAmount: Centavos; // server
  /** IIRUP after disposal. */
  disposalDate?: IsoDate | null;
  disposalReference?: string;
  disposalAmount?: Centavos;
}

export interface PpeMovement {
  date: IsoDate;
  type: 'ACQUIRED' | 'ISSUED' | 'TRANSFERRED' | 'RETURNED' | 'UNSERVICEABLE' | 'DISPOSED' | 'COUNTED';
  reference: string;
  person: string;
  location: string;
  remarks: string;
}

/** ppe/{id} as stored by this module (PpeDoc is frozen; extra fields live here). */
export interface PpeRecord extends PpeDoc {
  unit: string;
  remarks: string;
  condition: 'SERVICEABLE' | 'UNSERVICEABLE';
  openingAccumulatedDepreciation: Centavos;
  openingAsOfPeriod?: string | null;
  lastDepreciatedPeriod: string | null;
  parId: string | null;
  icsId?: string | null;
  iarId: string | null;
  iarNumber: string | null;
  supplierName: string;
  movements: PpeMovement[];
  disposalDate: IsoDate | null;
  lastCount: { date: IsoDate; found: boolean; condition: string; remarks: string } | null;
}

export interface InventoryItemRecord extends InventoryItemDoc {
  /** Server: posting sequence of the item's stock-card lines. */
  txCount: number;
  lastCount: { date: IsoDate; quantity: number; remarks: string } | null;
}

export interface InventoryTxRecord extends Omit<InventoryTransactionDoc, 'referenceType'> {
  referenceType: InventoryTransactionDoc['referenceType'] | 'ICS';
  seq: number;
  stockNumber: string;
  description: string;
  unit: string;
  accountCode: string;
  itemClass: InventoryItemDoc['itemClass'];
  office: string;
  remarks: string;
  sourceCollection: string | null;
  sourceId: string | null;
  balanceUnitCost: Centavos;
}

export interface PpeDepreciationDoc extends BarangayScoped {
  ppeId: string;
  propertyNumber: string;
  period: string; // YYYY-MM
  month: number;
  amount: Centavos;
  accumulatedAfter: Centavos;
  accountCode: string;
  accumulatedDepreciationAccountCode: string;
  depreciationExpenseAccountCode: string;
  runId: string;
  createdAt: Ts;
}

export interface DepreciationRunDoc extends BarangayScoped, Tracked {
  month: number;
  period: string;
  status: 'GENERATED';
  itemCount: number;
  totalDepreciation: Centavos;
  jevId: string | null;
  jevIds: string[];
  lines: Array<{ depreciationExpenseAccountCode: string; accumulatedDepreciationAccountCode: string; amount: Centavos }>;
}

export interface BioMovement {
  seq: number;
  date: IsoDate;
  kind: 'ACQUISITION' | 'BIRTH' | 'DEATH' | 'DISPOSITION';
  quantity: number;
  amount: Centavos;
  reference: string;
  remarks: string;
  balanceQuantity: number;
  balanceAmount: Centavos;
}

export interface BiologicalAssetDoc extends BarangayScoped, WorkflowTracked<string> {
  assetNumber: string | null;
  kind: string;
  description: string;
  unit: string;
  accountCode: string;
  acquisitionDate: IsoDate;
  quantity: number; // initial
  unitCost: Centavos;
  fairValue: Centavos | null;
  location: string;
  custodian: string;
  remarks: string;
  quantityOnHand: number; // server
  carryingAmount: Centavos; // server
  movements: BioMovement[]; // server
}

// ------------------------------------------------------------------ constants

export const ITEM_CLASSES = [
  { value: 'CONSUMABLE', label: 'Consumable supplies' },
  { value: 'SEMI_EXPENDABLE', label: 'Semi-expendable property' },
] as const;

export const DISPOSAL_MODES = [
  { value: 'SALE', label: 'Sale' },
  { value: 'TRANSFER', label: 'Transfer' },
  { value: 'DESTRUCTION', label: 'Destruction' },
  { value: 'OTHERS', label: 'Others' },
] as const;

export const TRANSFER_TYPES = ['Reassignment', 'Relocation', 'Donation', 'Others'] as const;
export const BIO_KINDS = ['ACQUISITION', 'BIRTH', 'DEATH', 'DISPOSITION'] as const;

// ------------------------------------------------------------------ workflow definitions

const ENC: Permission = 'property.manage';

/** Property Officer submits, PB approves (and the approval issues/numbers the document). */
function pbTransitions(approveLabel: string, approvedTo: string, confirm?: string): ModuleTransition[] {
  return [
    { action: 'SUBMIT', label: 'Submit for approval', from: ['DRAFT'], to: 'SUBMITTED', permission: ENC, tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'SUBMITTED', permission: ENC, tone: 'primary', auditAction: 'RESUBMIT' },
    { action: 'APPROVE', label: approveLabel, from: ['SUBMITTED'], to: approvedTo, permission: 'transaction.approve', segregation: true, tone: 'primary', ...(confirm ? { confirm } : {}) },
    { action: 'RETURN', label: 'Return…', from: ['SUBMITTED'], to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: ENC, requiresReason: true, tone: 'danger' },
  ];
}

const base = { encodePermission: ENC, editableStatuses: ['DRAFT', 'RETURNED'] as const };

export const PURCHASE_REQUEST_MODULE: SourceModuleDef = {
  ...base,
  key: 'purchaseRequest',
  collection: PROPERTY_COL.purchaseRequests,
  label: 'Purchase request',
  dateField: 'prDate',
  numberField: 'prNumber',
  transitions: [
    ...pbTransitions('Approve', 'APPROVED'),
    { action: 'CANCEL', label: 'Cancel…', from: ['APPROVED'], to: 'CANCELLED', permission: 'transaction.approve', requiresReason: true, tone: 'danger' },
  ],
};

export const PURCHASE_ORDER_MODULE: SourceModuleDef = {
  ...base,
  key: 'purchaseOrder',
  collection: PROPERTY_COL.purchaseOrders,
  label: 'Purchase order',
  dateField: 'poDate',
  numberField: 'poNumber',
  transitions: [
    ...pbTransitions('Approve & issue PO', 'APPROVED', 'Approving assigns the PO number; deliveries are then received on an Inspection and Acceptance Report.'),
    { action: 'CANCEL', label: 'Cancel…', from: ['APPROVED'], to: 'CANCELLED', permission: 'transaction.approve', requiresReason: true, tone: 'danger' },
  ],
};

const ACCEPT_CONFIRM = 'Accepting posts the supplies to their stock cards and creates PPE records (with property numbers) for capitalized equipment. This cannot be undone.';

export const INSPECTION_MODULE: SourceModuleDef = {
  ...base,
  key: 'inspection',
  collection: PROPERTY_COL.inspectionReports,
  label: 'Inspection and acceptance report',
  dateField: 'iarDate',
  numberField: 'documentNumber',
  transitions: pbTransitions('Inspect & accept', 'ACCEPTED', ACCEPT_CONFIRM),
};

export const DONATION_MODULE: SourceModuleDef = {
  ...base,
  key: 'donation',
  collection: PROPERTY_COL.inspectionReports,
  label: 'Donation receipt (ARDSM)',
  dateField: 'iarDate',
  numberField: 'documentNumber',
  transitions: pbTransitions('Accept donation', 'ACCEPTED', ACCEPT_CONFIRM),
};

export const REQUISITION_MODULE: SourceModuleDef = {
  ...base,
  key: 'requisition',
  collection: PROPERTY_COL.requisitions,
  label: 'Requisition and issue slip',
  dateField: 'risDate',
  numberField: 'risNumber',
  transitions: [
    ...pbTransitions('Approve request', 'APPROVED'),
    { action: 'ISSUE', label: 'Issue supplies', from: ['APPROVED'], to: 'ISSUED', permission: ENC, tone: 'primary', confirm: 'Issuing deducts the quantities from the stock cards at moving-average cost.' },
    { action: 'CANCEL', label: 'Cancel…', from: ['APPROVED'], to: 'CANCELLED', permission: 'transaction.approve', requiresReason: true, tone: 'danger' },
  ],
};

export const ICS_MODULE: SourceModuleDef = {
  ...base,
  key: 'ics',
  collection: COL.propertyDocuments,
  label: 'Inventory custodian slip',
  dateField: 'date',
  numberField: 'documentNumber',
  transitions: pbTransitions('Approve & issue ICS', 'ISSUED', 'Issuing assigns the ICS number and deducts the semi-expendable items from stock.'),
};

export const PAR_MODULE: SourceModuleDef = {
  ...base,
  key: 'par',
  collection: COL.propertyDocuments,
  label: 'Property acknowledgement receipt',
  dateField: 'date',
  numberField: 'documentNumber',
  transitions: pbTransitions('Approve & issue PAR', 'ISSUED', 'Issuing assigns the PAR number and makes the receiver accountable for the property.'),
};

export const PTR_MODULE: SourceModuleDef = {
  ...base,
  key: 'ptr',
  collection: COL.propertyDocuments,
  label: 'Property transfer report',
  dateField: 'date',
  numberField: 'documentNumber',
  transitions: pbTransitions('Approve transfer', 'ISSUED'),
};

export const RRPE_MODULE: SourceModuleDef = {
  ...base,
  key: 'rrpe',
  collection: COL.propertyDocuments,
  label: 'Receipt of returned property',
  dateField: 'date',
  numberField: 'documentNumber',
  transitions: pbTransitions('Approve return', 'ISSUED'),
};

export const IIRUP_MODULE: SourceModuleDef = {
  ...base,
  key: 'iirup',
  collection: COL.propertyDocuments,
  label: 'Unserviceable property report (IIRUP)',
  dateField: 'date',
  numberField: 'documentNumber',
  transitions: [
    ...pbTransitions('Approve (unserviceable)', 'APPROVED', 'The listed property becomes UNSERVICEABLE and stops depreciating.'),
    { action: 'DISPOSE', label: 'Record disposal', from: ['APPROVED'], to: 'DISPOSED', permission: ENC, tone: 'primary', confirm: 'The listed property is marked DISPOSED and drops off the RPCPPE. Accounting records the derecognition entry.' },
  ],
};

export const PPE_MODULE: SourceModuleDef = {
  ...base,
  key: 'ppe',
  collection: COL.ppe,
  label: 'PPE record',
  dateField: 'acquisitionDate',
  numberField: 'propertyNumber',
  transitions: pbTransitions('Approve (assign property no.)', 'ACTIVE'),
};

export const BIOLOGICAL_ASSET_MODULE: SourceModuleDef = {
  ...base,
  key: 'biologicalAsset',
  collection: COL.biologicalAssets,
  label: 'Biological asset',
  dateField: 'acquisitionDate',
  numberField: 'assetNumber',
  transitions: pbTransitions('Approve', 'ACTIVE'),
};

export const PROPERTY_DOC_MODULES: Record<PropertyDocumentType, SourceModuleDef> = { ICS: ICS_MODULE, PAR: PAR_MODULE, PTR: PTR_MODULE, RRPE: RRPE_MODULE, IIRUP: IIRUP_MODULE };

export const PROPERTY_MODULES: SourceModuleDef[] = [
  PURCHASE_REQUEST_MODULE,
  PURCHASE_ORDER_MODULE,
  INSPECTION_MODULE,
  DONATION_MODULE,
  REQUISITION_MODULE,
  ICS_MODULE,
  PAR_MODULE,
  PTR_MODULE,
  RRPE_MODULE,
  IIRUP_MODULE,
  PPE_MODULE,
  BIOLOGICAL_ASSET_MODULE,
];
