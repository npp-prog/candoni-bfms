import type { BarangayScoped, Centavos, IsoDate, Tracked, WorkflowTracked } from './common';

/** ppe/{id} */
export interface PpeDoc extends BarangayScoped, WorkflowTracked<'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'ACTIVE' | 'TRANSFERRED' | 'UNSERVICEABLE' | 'DISPOSED'> {
  propertyNumber: string;
  description: string;
  accountCode: string; // 1-07-05-020 …
  accumulatedDepreciationAccountCode: string; // 1-07-05-021
  depreciationExpenseAccountCode: string; // 5-04-01-040
  acquisitionDate: IsoDate;
  acquisitionCost: Centavos;
  residualValue: Centavos; // default 5% of cost (legacy practice for equipment)
  usefulLifeYears: number;
  depreciationStartPeriod: string; // YYYY-MM
  accumulatedDepreciation: Centavos; // server
  netBookValue: Centavos; // server
  location: string;
  accountablePerson: string;
  parNumber: string | null;
  icsNumber: string | null;
  sourceDvId: string | null;
  fundId: string;
}

/** inventoryItems/{id} */
export interface InventoryItemDoc extends BarangayScoped, Tracked {
  stockNumber: string;
  description: string;
  unit: string;
  accountCode: string; // 1-04-xx
  itemClass: 'CONSUMABLE' | 'SEMI_EXPENDABLE';
  reorderPoint: number;
  quantityOnHand: number;
  unitCost: Centavos; // moving average
  active: boolean;
}

/** inventoryTransactions/{id} — stock-card lines (RIS, IAR, adjustments) */
export interface InventoryTransactionDoc extends BarangayScoped, Tracked {
  itemId: string;
  date: IsoDate;
  kind: 'RECEIPT' | 'ISSUE' | 'RETURN' | 'ADJUSTMENT' | 'DONATION_RECEIVED';
  referenceType: 'IAR' | 'RIS' | 'RRSP' | 'ARDSM' | 'ADJ';
  referenceNumber: string;
  quantity: number; // signed
  unitCost: Centavos;
  totalCost: Centavos;
  officeId: string | null;
  balanceQuantity: number; // server
}
