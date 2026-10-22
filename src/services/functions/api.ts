import type { BarangayId, BarangayScope, JournalLineInput, RoleCode } from '@bfms/shared';
import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { functions } from '../firebase/app';

/** Typed wrapper for a Cloud Function. Module folders use it for their own callables. */
export function callFn<I, O>(name: string) {
  return call<I, O>(name);
}

/** Typed wrappers for Cloud Functions. All sensitive writes go through here. */
function call<I, O>(name: string) {
  const fn = httpsCallable<I, O>(functions, name);
  return async (input: I): Promise<O> => ((await fn(input)) as HttpsCallableResult<O>).data;
}

export const api = {
  recordLogin: call<Record<string, never>, { assignments: unknown[] }>('recordLogin'),
  createUserAccount: call<{ email: string; displayName: string; position?: string; defaultBarangayId?: BarangayScope | null }, { uid: string }>('createUserAccount'),
  setUserAssignment: call<{ uid: string; barangayId: BarangayScope; roles: RoleCode[]; validFrom?: string; validTo?: string | null; remarks?: string }, { assignmentId: string }>('setUserAssignment'),
  revokeUserAssignment: call<{ assignmentId: string; reason: string }, { ok: true }>('revokeUserAssignment'),
  setUserActive: call<{ uid: string; active: boolean; reason: string }, { ok: true }>('setUserActive'),
  seedReferenceData: call<{ overwriteCatalogs?: boolean }, { created: Record<string, number> }>('seedReferenceData'),
  createFiscalYear: call<{ fiscalYear: number }, { fiscalYear: number }>('createFiscalYear'),
  openBarangayFiscalYear: call<{ barangayId: BarangayId; fiscalYear: number }, { ok: true }>('openBarangayFiscalYear'),
  setPeriodReview: call<{ barangayId: BarangayId; fiscalYear: number; month: number; review: boolean; reason?: string }, { status: string }>('setPeriodReview'),
  lockAccountingPeriod: call<{ barangayId: BarangayId; fiscalYear: number; month: number; reason?: string }, { status: string }>('lockAccountingPeriod'),
  reopenAccountingPeriod: call<{ barangayId: BarangayId; fiscalYear: number; month: number; reason: string }, { status: string; staleReports: number }>('reopenAccountingPeriod'),
  saveJournalDraft: call<
    {
      jevId?: string;
      barangayId: BarangayId;
      jevDate: string;
      fundId: string;
      journal: 'JCT' | 'GJ';
      entryType?: 'REGULAR' | 'ADJUSTING' | 'CORRECTING' | 'OPENING';
      primaryReference?: string | null;
      secondaryReference?: string | null;
      particulars: string;
      lines: JournalLineInput[];
    },
    { jevId: string }
  >('saveJournalDraft'),
  submitJournalEntry: call<{ jevId: string; remarks?: string }, { status: string }>('submitJournalEntry'),
  approveJournalEntry: call<{ jevId: string; remarks?: string }, { status: string }>('approveJournalEntry'),
  returnJournalEntry: call<{ jevId: string; remarks: string }, { status: string }>('returnJournalEntry'),
  postJournalEntry: call<{ jevId: string }, { jevNumber: string; alreadyPosted: boolean }>('postJournalEntry'),
  reverseJournalEntry: call<{ jevId: string; reversalDate: string; reason: string }, { reversalJevId: string; jevNumber: string }>('reverseJournalEntry'),

  // Generic source-document engine (Phases 3–10).
  saveSource: call<{ module: string; id?: string; barangayId: BarangayId; data: unknown }, { id: string }>('saveSource'),
  sourceAction: call<{ module: string; id: string; action: string; remarks?: string; payload?: Record<string, unknown> }, { status: string; number: string | null; jevId: string | null }>('sourceAction'),

  // Barangay setup masters.
  saveBankAccount: call<{ id?: string; barangayId: BarangayId; bankName: string; branch: string; accountName: string; accountNumber: string; accountType: 'CURRENT' | 'SAVINGS' | 'TIME_DEPOSIT'; fundId: string; subsidiaryCode: string; active: boolean }, { id: string; subsidiaryId: string }>('saveBankAccount'),
  saveSubsidiaryAccount: call<{ barangayId: BarangayId; accountCode: string; subsidiaryCode: string; subsidiaryName: string; type: string; partyId?: string | null; active: boolean }, { id: string }>('saveSubsidiaryAccount'),
  saveSignatory: call<{ id?: string; barangayId: BarangayId | 'MUNICIPAL'; role: string; name: string; position: string; validFrom: string; validTo: string | null; active: boolean }, { id: string }>('saveSignatory'),
  saveOffice: call<{ id?: string; barangayId: BarangayId; officeCode: string; officeName: string; active: boolean }, { id: string }>('saveOffice'),

  // Budget.
  saveEstimatedIncome: call<{ barangayId: BarangayId; fiscalYear: number; fundId: string; incomeAccountCode: string; estimatedIncome: number }, { id: string }>('saveEstimatedIncome'),
};

/** Human message from a Functions error (HttpsError carries the BfmsError message). */
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return 'Something went wrong.';
}
