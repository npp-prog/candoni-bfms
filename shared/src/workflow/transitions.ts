import { BfmsError } from '../accounting/errors';
import type { Permission } from '../security/permissions';

export interface Transition {
  from: readonly string[];
  to: string;
  action: string;
  permission: Permission;
  /** requires remarks (return, void, reopen) */
  requiresReason?: boolean;
}

/** Generic source-document workflow (docs/architecture/05-workflows.md §10). */
export const SOURCE_TRANSITIONS: readonly Transition[] = [
  { action: 'SUBMIT', from: ['DRAFT'], to: 'SUBMITTED', permission: 'treasury.submit' },
  { action: 'RESUBMIT', from: ['RETURNED'], to: 'RESUBMITTED', permission: 'treasury.submit' },
  { action: 'START_REVIEW', from: ['SUBMITTED', 'RESUBMITTED'], to: 'FOR_REVIEW', permission: 'submission.review' },
  { action: 'RETURN', from: ['SUBMITTED', 'RESUBMITTED', 'FOR_REVIEW'], to: 'RETURNED', permission: 'submission.review', requiresReason: true },
  { action: 'APPROVE', from: ['SUBMITTED'], to: 'APPROVED', permission: 'transaction.approve' },
  { action: 'ACCEPT', from: ['FOR_REVIEW', 'APPROVED'], to: 'ACCEPTED', permission: 'submission.accept' },
  { action: 'VOID', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: 'treasury.encode', requiresReason: true },
  { action: 'VOID', from: ['SUBMITTED', 'FOR_REVIEW', 'APPROVED'], to: 'VOID', permission: 'jev.approve', requiresReason: true },
];

/** JEV workflow (Section XLII). POST and REVERSE are dedicated functions with extra checks. */
export const JEV_TRANSITIONS: readonly Transition[] = [
  { action: 'SUBMIT', from: ['DRAFT', 'RETURNED'], to: 'FOR_REVIEW', permission: 'jev.prepare' },
  { action: 'RETURN', from: ['FOR_REVIEW', 'APPROVED'], to: 'RETURNED', permission: 'jev.review', requiresReason: true },
  { action: 'APPROVE', from: ['FOR_REVIEW'], to: 'APPROVED', permission: 'jev.approve' },
  { action: 'POST', from: ['APPROVED'], to: 'POSTED', permission: 'jev.post' },
  { action: 'REVERSE', from: ['POSTED'], to: 'REVERSED', permission: 'jev.reverse', requiresReason: true },
];

export function findTransition(table: readonly Transition[], action: string, from: string): Transition {
  const t = table.find((x) => x.action === action && x.from.includes(from));
  if (!t) throw new BfmsError('INVALID_STATUS', `Action ${action} is not allowed while the record is ${from}.`, { action, from });
  return t;
}

/**
 * Segregation of duties: the preparer of a record may not approve/post it.
 * `allowSelfPost` is a logged, off-by-default fallback for very small offices.
 */
export function assertSegregation(preparerUid: string, actorUid: string, action: string, allowSelfPost = false): void {
  if (preparerUid === actorUid && !allowSelfPost)
    throw new BfmsError('SEGREGATION_OF_DUTIES', `You prepared this record, so you cannot ${action.toLowerCase()} it.`);
}
