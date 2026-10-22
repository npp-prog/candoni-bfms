/**
 * BFMS Cloud Functions entry point (region asia-southeast1).
 * Phase 1: security, calendar, numbering, audit, JEV engine.
 * Phases 3–12: generic source-document engine (saveSource/sourceAction) + per-module callables.
 */
export { createUserAccount, setUserAssignment, revokeUserAssignment, setUserActive, recordLogin } from './security/users';
export { onUserAssignmentWritten, resyncDatedAssignments } from './security/claims';
export { seedReferenceData } from './admin/seed';
export {
  createFiscalYear,
  openBarangayFiscalYear,
  setPeriodReview,
  lockAccountingPeriod,
  reopenAccountingPeriod,
} from './closing/periods';
export { saveJournalDraft, submitJournalEntry, approveJournalEntry, returnJournalEntry } from './accounting/journal';
export { postJournalEntry, reverseJournalEntry } from './accounting/posting';

import './modules/registry';
export { saveSource, sourceAction } from './sources/engine';
export * from './setup/masters';
export * from './modules/budget/callables';
export * from './modules/collections/callables';
export * from './modules/disbursements/callables';
export * from './modules/cashAdvances/callables';
export * from './modules/books/callables';
export * from './modules/bank/callables';
export * from './modules/property/callables';
export * from './reports/callables';
