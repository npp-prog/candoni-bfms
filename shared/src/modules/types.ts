import type { Permission } from '../security/permissions';
import type { AuditAction } from '../types/audit';
import type { SourceModule as JevSourceModule } from '../types/accounting';

/**
 * Declarative definition of a barangay SOURCE DOCUMENT module (appropriation, DV, collection …).
 * Shared by the server engine (functions/src/sources/engine.ts), which enforces it, and by the UI,
 * which uses it to show only the actions the user may take.
 */
export interface ModuleTransition {
  /** Stable action id sent to `sourceAction` (SUBMIT, APPROVE, CERTIFY, ISSUE …). */
  action: string;
  /** Button label in the UI. */
  label: string;
  from: readonly string[];
  to: string;
  permission: Permission;
  /** Remarks of at least 5 characters are required (return, void, cancel). */
  requiresReason?: boolean;
  /** The actor may not be the record's preparer (segregation of duties). */
  segregation?: boolean;
  /** Visual weight of the button. */
  tone?: 'primary' | 'secondary' | 'danger';
  /** Audit action recorded; defaults to a sensible mapping of `action`. */
  auditAction?: AuditAction;
  /** Short confirmation text shown before the action runs. */
  confirm?: string;
}

export interface SourceModuleDef {
  /** Registry key used by `saveSource({ module })` and `sourceAction({ module })`. */
  key: string;
  collection: string;
  label: string;
  /** Accounting date field that decides the period (dvDate, collectionDate …). */
  dateField: string;
  /** Field holding the server-assigned document number, if any. */
  numberField?: string;
  /** Permission needed to create/edit DRAFT and RETURNED records. */
  encodePermission: Permission;
  /** Statuses in which the record is editable by `saveSource`. */
  editableStatuses: readonly string[];
  transitions: readonly ModuleTransition[];
  /** JEV source module when acceptance generates a journal entry. */
  jevSource?: JevSourceModule;
}

/**
 * The common barangay → accounting lifecycle (docs/architecture/05-workflows.md §10).
 * Modules compose it: `standardTransitions({ approve: true, accept: true })`.
 */
export function standardTransitions(
  opts: { approve?: boolean; accept?: boolean; submitPermission?: Permission; encodePermission?: Permission; approveLabel?: string } = {},
): ModuleTransition[] {
  const submit = opts.submitPermission ?? 'treasury.submit';
  const t: ModuleTransition[] = [
    { action: 'SUBMIT', label: 'Submit', from: ['DRAFT'], to: 'SUBMITTED', permission: submit, tone: 'primary' },
    { action: 'RESUBMIT', label: 'Resubmit', from: ['RETURNED'], to: 'RESUBMITTED', permission: submit, tone: 'primary', auditAction: 'RESUBMIT' },
  ];
  const pending = ['SUBMITTED', 'RESUBMITTED'];
  if (opts.approve) {
    // Punong Barangay approves or returns what the treasurer submitted.
    t.push(
      { action: 'APPROVE', label: opts.approveLabel ?? 'Approve', from: pending, to: 'APPROVED', permission: 'transaction.approve', segregation: true, tone: 'primary' },
      { action: 'RETURN', label: 'Return…', from: pending, to: 'RETURNED', permission: 'transaction.approve', requiresReason: true, tone: 'secondary' },
    );
  }
  // Accounting reviews what reached it: approved records (approve flow) or submitted ones.
  const review = opts.approve ? ['APPROVED'] : pending;
  if (opts.accept || !opts.approve)
    t.push({ action: 'RETURN', label: 'Return…', from: review, to: 'RETURNED', permission: 'submission.review', requiresReason: true, tone: 'secondary' });
  if (opts.accept)
    t.push({ action: 'ACCEPT', label: 'Accept & generate JEV', from: review, to: 'ACCEPTED', permission: 'submission.accept', segregation: true, tone: 'primary', confirm: 'Accepting creates a DRAFT journal entry for Municipal Accounting to review, approve and post.' });
  t.push(
    { action: 'VOID', label: 'Void…', from: ['DRAFT', 'RETURNED'], to: 'VOID', permission: opts.encodePermission ?? 'treasury.encode', requiresReason: true, tone: 'danger' },
    { action: 'VOID', label: 'Void…', from: ['SUBMITTED', 'RESUBMITTED', 'APPROVED'], to: 'VOID', permission: 'jev.approve', requiresReason: true, tone: 'danger' },
  );
  return t;
}

/** Transitions available from a status (deduplicated by action, first match wins). */
export function transitionsFrom(def: SourceModuleDef, status: string): ModuleTransition[] {
  const seen = new Set<string>();
  return def.transitions.filter((t) => t.from.includes(status) && !seen.has(t.action) && seen.add(t.action));
}

/** All transitions matching action+status (several may exist with different permissions). */
export function matchingTransitions(def: SourceModuleDef, action: string, status: string): ModuleTransition[] {
  return def.transitions.filter((t) => t.action === action && t.from.includes(status));
}
