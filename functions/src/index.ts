/**
 * BFMS Cloud Functions entry point (region asia-southeast1).
 * Phase 1: security, calendar, numbering, audit, JEV engine.
 * Later phases register their functions here (see docs/architecture/04-accounting-engine.md §8).
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
