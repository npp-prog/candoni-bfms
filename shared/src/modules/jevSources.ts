import { COL } from '../constants/collections';
import type { SourceModule } from '../types/accounting';

/**
 * Where a generated JEV's source document lives, and whether that document follows the
 * workflow status machine. postJournalEntry stamps the source with {jevId, jevNumber} and, for
 * workflow documents, status POSTED (it must be ACCEPTED or APPROVED first).
 */
export const JEV_SOURCES: Partial<Record<SourceModule, { collection: string; workflow: boolean }>> = {
  RCD: { collection: COL.rcdReports, workflow: true },
  DEPOSIT: { collection: COL.deposits, workflow: true },
  COLLECTION: { collection: COL.collections, workflow: true },
  DV: { collection: COL.disbursementVouchers, workflow: true },
  PAYROLL: { collection: COL.payrolls, workflow: true },
  LIQUIDATION: { collection: COL.liquidations, workflow: true },
  PETTY_CASH: { collection: COL.pettyCashTransactions, workflow: true },
  STF: { collection: COL.specialTrustFunds, workflow: false },
  BANK_MEMO: { collection: COL.bankMemos, workflow: false },
  DEPRECIATION: { collection: 'depreciationRuns', workflow: false },
  INVENTORY: { collection: COL.inventoryTransactions, workflow: false },
};
