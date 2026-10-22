import { callFn } from '../../services/functions/api';

/** Phase 5 callables (functions/src/modules/disbursements/callables.ts). */
export const disbApi = {
  createDvFromPayroll: callFn<{ payrollId: string; dvDate: string; paymentMethod: 'CHECK' | 'ADA' | 'CASH'; bankAccountId?: string | null; cashOfficerId?: string | null }, { dvId: string }>('createDvFromPayroll'),
  cancelCheck: callFn<{ checkId: string; status: 'CANCELLED' | 'VOID'; reason: string; cancelledDate?: string }, { status: string }>('cancelCheck'),
  setPayrollSignatures: callFn<{ payrollId: string; signed: boolean[] }, { signed: number }>('setPayrollSignatures'),
};
