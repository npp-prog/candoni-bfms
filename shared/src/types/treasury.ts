import type { CashAdvanceStatus, CheckStatus } from '../constants/statuses';
import type {
  BarangayScoped,
  Centavos,
  FundId,
  IsoDate,
  PartyRef,
  PeriodScoped,
  Ts,
  WorkflowTracked,
} from './common';

type SourceStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'FOR_REVIEW'
  | 'RETURNED'
  | 'RESUBMITTED'
  | 'APPROVED'
  | 'ACCEPTED'
  | 'POSTED'
  | 'VOID';

export type PaymentMethod = 'CASH' | 'CHECK' | 'ADA' | 'BANK_TRANSFER' | 'OTHER';

export interface CollectionLine {
  accountCode: string;
  subsidiaryId: string | null;
  natureOfCollection: string;
  amount: Centavos;
}

/** collections/{id} */
export interface CollectionDoc extends PeriodScoped, WorkflowTracked<SourceStatus | 'CANCELLED'> {
  fundId: FundId;
  collectionDate: IsoDate;
  officialReceiptNumber: string;
  accountableFormId: string;
  accountableFormSeries: string;
  payor: PartyRef;
  lines: CollectionLine[];
  amount: Centavos; // server = Σ lines
  paymentMethod: PaymentMethod;
  checkDetails?: { bank: string; checkNumber: string; checkDate: IsoDate } | null;
  collectingOfficerId: string; // subsidiary of 1-01-01-010 (BT##)
  depositId: string | null;
  rcdId: string | null;
  cancelReason?: string | null;
  jevId?: string | null;
}

/** deposits/{id} */
export interface DepositDoc extends PeriodScoped, WorkflowTracked<SourceStatus> {
  fundId: FundId;
  depositDate: IsoDate;
  bankAccountId: string;
  depositSlipNumber: string;
  collectionIds: string[];
  amount: Centavos; // encoded per deposit slip
  validatedAmount: Centavos | null; // per bank validation
  attachmentIds: string[];
  rcdId: string | null;
}

/** rcdReports/{id} — Report of Collections and Deposits. */
export interface RcdDoc extends PeriodScoped, WorkflowTracked<SourceStatus> {
  rcdNumber: string | null;
  fundId: FundId;
  accountableOfficerId: string;
  dateFrom: IsoDate;
  dateTo: IsoDate;
  collectionIds: string[];
  depositIds: string[];
  totalCollections: Centavos;
  totalDeposits: Centavos;
  undeposited: Centavos;
  differenceExplanation: string | null;
  jevId: string | null;
}

/** accountableForms/{id} */
export interface AccountableFormDoc extends BarangayScoped, WorkflowTracked<'ACTIVE' | 'EXHAUSTED' | 'RETURNED' | 'VOID' | 'DRAFT'> {
  formType: 'AF51' | 'AF52' | 'AF53' | 'AF56' | 'CTC' | 'OTHER';
  accountableOfficerId: string;
  series: string;
  beginningSerialNumber: number;
  endingSerialNumber: number;
  quantityReceived: number;
  quantityIssued: number;
  quantityUsed: number;
  quantityCancelled: number;
  endingBalance: number;
  nextSerialNumber: number;
  dateReceived: IsoDate;
  dateIssued: IsoDate | null;
}

/** disbursementVouchers/{id} */
export interface DisbursementVoucherDoc extends PeriodScoped, WorkflowTracked<SourceStatus> {
  dvNumber: string | null; // YYYY-MM-NNN (server, at approval)
  dvDate: IsoDate;
  dvCategory: 'REGULAR' | 'CASH_ADVANCE' | 'PAYROLL' | 'REIMBURSEMENT' | 'REMITTANCE' | 'TRANSFER' | 'OTHER';
  payee: PartyRef;
  particulars: string;
  fundId: FundId;
  officeId: string | null;
  fppId: string | null;
  obligationId: string | null;
  charges: Array<{ accountCode: string; subsidiaryId: string | null; amount: Centavos }>;
  grossAmount: Centavos;
  taxDeductions: Array<{ taxType: 'EWT' | 'VAT' | 'PT' | 'DST' | 'OTHER'; rateBp: number; amount: Centavos }>;
  otherDeductions: Array<{ description: string; accountCode: string; subsidiaryId: string | null; amount: Centavos }>;
  netAmount: Centavos; // server-computed
  paymentMethod: PaymentMethod;
  checkId: string | null;
  cashAdvanceId: string | null;
  payrollId: string | null;
  supportingDocumentIds: string[];
  jevId: string | null;
}

/** checks/{id} — uniqueness via uniqueKeys/CHK_{bid}_{bankAccountId}_{checkNumber} */
export interface CheckDoc extends BarangayScoped {
  bankAccountId: string;
  checkNumber: string;
  checkDate: IsoDate;
  payee: PartyRef;
  dvId: string | null;
  amount: Centavos;
  releasedDate: IsoDate | null;
  clearedDate: IsoDate | null;
  status: CheckStatus;
  cancelReason: string | null;
  createdAt: Ts;
  createdBy: string;
  updatedAt: Ts;
  updatedBy: string;
}

export interface PayrollEntry {
  payeeId: string | null;
  payeeName: string;
  position: string;
  grossAmount: Centavos;
  deductions: Array<{ description: string; accountCode: string; amount: Centavos }>;
  netAmount: Centavos;
  signed: boolean;
}

/** payrolls/{id} (+ entries subcollection when > 50 payees) */
export interface PayrollDoc extends PeriodScoped, WorkflowTracked<SourceStatus> {
  payrollNumber: string | null;
  payrollType: 'HONORARIA' | 'EMPLOYEES' | 'LABOR' | 'ALLOWANCE' | 'OTHER';
  payPeriodFrom: IsoDate;
  payPeriodTo: IsoDate;
  fundId: FundId;
  appropriationId: string | null;
  obligationId: string | null;
  expenseAccountCode: string;
  paymentMethod: 'CASH_ADVANCE' | 'CHECK' | 'ADA';
  entryCount: number;
  grossAmount: Centavos;
  totalDeductions: Centavos;
  netAmount: Centavos;
  dvId: string | null;
  cashAdvanceId: string | null;
  liquidationId: string | null;
}

export type CashAdvanceType = 'PAYROLL' | 'OFFICIAL_TRAVEL' | 'SPECIAL_PURPOSE' | 'PETTY_CASH' | 'OTHER_AUTHORIZED';

/** cashAdvances/{id} — created by server from an approved CA-category DV. */
export interface CashAdvanceDoc extends BarangayScoped {
  accountableOfficerId: string; // subsidiaryAccounts id under 1-03-03-010 / -020
  accountableOfficerName: string;
  accountCode: '1-03-03-010' | '1-03-03-020' | string;
  cashAdvanceType: CashAdvanceType;
  dvId: string;
  dvNumber: string;
  checkId: string | null;
  checkNumber: string | null;
  grantDate: IsoDate;
  purpose: string;
  amountGranted: Centavos;
  amountLiquidated: Centavos;
  amountRefunded: Centavos;
  outstandingBalance: Centavos;
  liquidationDueDate: IsoDate;
  daysOutstanding: number;
  agingCategory: string;
  status: CashAdvanceStatus;
  isLegacy: boolean; // migrated opening balance
  updatedAt: Ts;
}

export interface LiquidationItem {
  date: IsoDate;
  supplier: string;
  officialReceiptNumber: string | null;
  invoiceNumber: string | null;
  particulars: string;
  accountCode: string;
  subsidiaryId: string | null;
  amount: Centavos;
  attachmentIds: string[];
}

/** liquidations/{id} (+ items subcollection) */
export interface LiquidationDoc extends PeriodScoped, WorkflowTracked<SourceStatus> {
  liquidationNumber: string | null;
  cashAdvanceId: string;
  accountableOfficerId: string;
  liquidationDate: IsoDate;
  itemCount: number;
  totalSupported: Centavos; // server Σ items
  cashRefunded: Centavos;
  refundOrNumber: string | null;
  cashAdvanceAmount: Centavos; // snapshot
  balanceRemaining: Centavos; // server
  jevId: string | null;
}

/** pettyCashFunds/{id} */
export interface PettyCashFundDoc extends BarangayScoped {
  custodianId: string;
  fundAmount: Centavos;
  cashOnHand: Centavos;
  unreplenished: Centavos;
  status: 'ACTIVE' | 'CLOSED';
  establishedDvId: string;
}

/** pettyCashTransactions/{id} */
export interface PettyCashTransactionDoc extends PeriodScoped, WorkflowTracked<SourceStatus> {
  pettyCashFundId: string;
  kind: 'ESTABLISH' | 'PAYMENT' | 'REPLENISH' | 'RETURN' | 'YEAR_END_CLOSE';
  pcvNumber: string | null;
  date: IsoDate;
  payee: PartyRef;
  particulars: string;
  accountCode: string | null;
  amount: Centavos;
  replenishmentDvId: string | null;
  attachmentIds: string[];
}

/** specialTrustFunds/{id} */
export interface SpecialTrustFundDoc extends BarangayScoped {
  fundId: FundId;
  fundCode: string; // e.g. TRUST106
  fundName: string;
  source: string; // DOH, DILG, POPCOM, PNO …
  purpose: string;
  dateReceived: IsoDate;
  amountReceived: Centavos;
  amountObligated: Centavos;
  amountDisbursed: Centavos;
  adjustments: Centavos;
  balance: Centavos; // server: received + adjustments − obligated
  status: 'ACTIVE' | 'FULLY_UTILIZED' | 'RETURNED' | 'CLOSED';
}
