import type { BarangayScoped, Centavos, FundId, IsoDate, PartyRef, Ts, WorkflowTracked } from './common';

/** Drives separate RAOs (Section XVII). */
export type AppropriationClass =
  | 'REGULAR'
  | 'SK_10PCT'
  | 'LDRRMF_5PCT'
  | 'DF_20PCT'
  | 'CONTINUING'
  | 'OTHER';

export type ExpenseClass = 'PS' | 'MOOE' | 'FE' | 'CO';

/** appropriations/{id} */
export interface AppropriationDoc
  extends BarangayScoped,
    WorkflowTracked<'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED' | 'ACTIVE' | 'CLOSED'> {
  appropriationOrdinanceNumber: string;
  appropriationOrdinanceDate: IsoDate;
  fundId: FundId;
  appropriationClass: AppropriationClass;
  expenseClass: ExpenseClass;
  fppId: string | null;
  program: string;
  project: string;
  activity: string;
  accountCode: string;
  originalAppropriation: Centavos;
  supplementalAppropriation: Centavos; // server-maintained from appropriationAdjustments
  realignment: Centavos; // signed
  adjustments: Centavos; // signed
  totalAppropriation: Centavos; // server-computed
  obligations: Centavos; // server-computed
  availableBalance: Centavos; // server-computed
}

/** appropriationAdjustments/{id} */
export interface AppropriationAdjustmentDoc
  extends BarangayScoped,
    WorkflowTracked<'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED'> {
  appropriationId: string;
  adjustmentType: 'SUPPLEMENTAL' | 'REALIGNMENT_IN' | 'REALIGNMENT_OUT' | 'AUGMENTATION' | 'OTHER';
  ordinanceNumber: string;
  ordinanceDate: IsoDate;
  amount: Centavos; // always positive; direction from adjustmentType
  counterpartAppropriationId: string | null;
  remarks: string;
}

/** obligations/{id} */
export interface ObligationDoc
  extends BarangayScoped,
    WorkflowTracked<'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'CERTIFIED' | 'CANCELLED' | 'VOID'> {
  obligationNumber: string | null; // OBR-YYYY-MM-NNN (server)
  date: IsoDate;
  payee: PartyRef;
  fundId: FundId;
  appropriationId: string;
  specialTrustFundId: string | null;
  program: string;
  project: string;
  activity: string;
  accountCode: string;
  particulars: string;
  amount: Centavos;
  certifiedBy: string | null;
  certifiedAt: Ts | null;
}

/** raoEntries/{id} — generated; never client-written. */
export interface RaoEntryDoc extends BarangayScoped {
  appropriationId: string;
  appropriationClass: AppropriationClass;
  date: IsoDate;
  reference: string;
  particulars: string;
  appropriation: Centavos;
  obligation: Centavos;
  adjustment: Centavos;
  remainingBalance: Centavos;
  sourceType: 'APPROPRIATION' | 'ADJUSTMENT' | 'OBLIGATION' | 'OBLIGATION_CANCEL';
  sourceId: string;
  createdAt: Ts;
}

/** estimatedIncome/{id} — REAI estimates. Actuals are derived from posted collections. */
export interface EstimatedIncomeDoc extends BarangayScoped {
  incomeAccountCode: string;
  fundId: FundId;
  estimatedIncome: Centavos;
  monthlyActual: Centavos[]; // length 12, server-maintained
  yearToDateActual: Centavos;
  variance: Centavos;
  collectionRateBp: number; // basis points (10000 = 100%)
}
