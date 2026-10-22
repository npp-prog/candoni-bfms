import type { BarangayId, CashAdvanceType } from '@bfms/shared';
import { callFn } from '../../services/functions/api';

/** Phases 6–7 callables (functions/src/modules/cashAdvances/callables.ts). */
export const caApi = {
  recordLegacyCashAdvance: callFn<
    { id?: string | null; barangayId: BarangayId; accountableOfficerId: string; cashAdvanceType: CashAdvanceType; purpose: string; grantDate: string; dvNumber: string; checkNumber?: string | null; amountGranted: number; openingLiquidated: number; liquidationDueDate?: string | null },
    { id: string }
  >('recordLegacyCashAdvance'),
  recomputeCashAdvanceAging: callFn<{ barangayId: BarangayId; asOf?: string | null }, { updated: number; overdue: number; open: number }>('recomputeCashAdvanceAging'),
  establishPettyCashFund: callFn<{ barangayId: BarangayId; custodianId: string; fundName: string; fundAmount: number; dateEstablished: string; establishedDvId?: string | null; establishedDvNumber: string }, { id: string }>('establishPettyCashFund'),
  closePettyCashFund: callFn<{ fundId: string; date: string; kind: 'RETURN' | 'YEAR_END_CLOSE'; refundOrNumber: string; cashSubsidiaryId: string; remarks?: string }, { transactionId: string; jevId: string | null; amount: number }>('closePettyCashFund'),
  registerSpecialTrustFund: callFn<
    { barangayId: BarangayId; fundCode: string; fundName: string; source: string; purpose: string; dateReceived: string; amountReceived: number; reference: string; bankAccountId?: string | null },
    { id: string; jevId: string | null }
  >('registerSpecialTrustFund'),
  adjustSpecialTrustFund: callFn<{ stfId: string; date: string; kind: string; amount: number; reference: string; reason: string }, { balance: number; status: string }>('adjustSpecialTrustFund'),
  refreshSpecialTrustFunds: callFn<{ barangayId: BarangayId }, { funds: number; updated: number }>('refreshSpecialTrustFunds'),
};

