import type { BarangayId, LineClass, ManualMatch, ManualReconItem } from '@bfms/shared';
import { callFn } from '../../services/functions/api';

/** Phase 9 callables (functions/src/modules/bank/callables.ts). */
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
}

export const bankApi = {
  saveBankStatement: callFn<
    BankPeriodInput & {
      statementDate?: string | null;
      beginningBalance: number;
      endingBalance: number;
      source: 'MANUAL' | 'IMPORT';
      lines: Array<{ lineId?: string | null; date: string; reference: string; description: string; debit: number; credit: number }>;
    },
    { id: string; balanced: boolean; computedEndingBalance: number; lineIds: string[] }
  >('saveBankStatement'),
  prepareBankReconciliation: callFn<
    BankPeriodInput & { classifications?: Record<string, LineClass>; manualItems?: ManualReconItem[]; manualMatches?: ManualMatch[]; remarks?: string },
    PrepareResult
  >('prepareBankReconciliation'),
  submitBankReconciliation: callFn<{ id: string; remarks?: string }, { status: string }>('submitBankReconciliation'),
  returnBankReconciliation: callFn<{ id: string; remarks: string }, { status: string }>('returnBankReconciliation'),
  finalizeBankReconciliation: callFn<{ id: string; remarks?: string }, { status: string }>('finalizeBankReconciliation'),
  generateRbdcmEntries: callFn<BankPeriodInput, { created: number; jevs: number; memoIds: string[] }>('generateRbdcmEntries'),
};
