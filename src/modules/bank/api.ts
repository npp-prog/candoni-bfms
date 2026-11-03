import type { BarangayId, LineClass, ManualMatch, ManualReconItem, OpeningCheck, OpeningDeposit } from '@bfms/shared';
import { callFn } from '../../services/functions/api';

/** Bank reconciliation callables (functions/src/modules/bank/callables.ts, functions/src/accounting/cancelledChecks.ts). */
export interface BankPeriodInput {
  barangayId: BarangayId;
  bankAccountId: string;
  fiscalYear: number;
  month: number;
}

export interface PrepareResult {
  id: string;
  bookBalance: number;
  bankBalance: number;
  adjustedBookBalance: number;
  adjustedBankBalance: number;
  difference: number;
  matches: number;
  items: number;
  unmatchedLines: number;
  outstandingChecks: number;
  depositInTransit: number;
  warnings: string[];
}

export interface StatementLinePayload {
  lineId?: string | null;
  date: string;
  reference: string;
  checkNumber?: string | null;
  description: string;
  debit: number;
  credit: number;
}

export const bankApi = {
  saveBankStatement: callFn<
    BankPeriodInput & { statementDate?: string | null; beginningBalance: number; endingBalance: number; source: 'MANUAL' | 'IMPORT'; lines: StatementLinePayload[] },
    { id: string; balanced: boolean; computedEndingBalance: number; lineIds: string[] }
  >('saveBankStatement'),
  saveBankOpeningItems: callFn<
    { barangayId: BarangayId; bankAccountId: string; fiscalYear: number; bankBalance?: number | null; remarks?: string; outstandingChecks: OpeningCheck[]; depositsInTransit: OpeningDeposit[] },
    { id: string; totalOutstandingChecks: number; totalDepositsInTransit: number }
  >('saveBankOpeningItems'),
  prepareBankReconciliation: callFn<
    BankPeriodInput & { classifications?: Record<string, LineClass>; manualItems?: ManualReconItem[]; manualMatches?: ManualMatch[]; remarks?: string },
    PrepareResult
  >('prepareBankReconciliation'),
  submitBankReconciliation: callFn<{ id: string; remarks?: string }, { status: string }>('submitBankReconciliation'),
  returnBankReconciliation: callFn<{ id: string; remarks: string }, { status: string }>('returnBankReconciliation'),
  finalizeBankReconciliation: callFn<{ id: string; remarks?: string }, { status: string }>('finalizeBankReconciliation'),
  generateRbdcmEntries: callFn<BankPeriodInput, { created: number; jevs: number; memoIds: string[] }>('generateRbdcmEntries'),
  recordCancelledCheck: callFn<
    { barangayId: BarangayId; bankAccountId: string; checkNumber: string; checkDate: string; payeeName?: string | null; remarks?: string },
    { id: string }
  >('recordCancelledCheck'),
  deleteCancelledCheck: callFn<{ id: string; reason: string }, { ok: boolean }>('deleteCancelledCheck'),
};
