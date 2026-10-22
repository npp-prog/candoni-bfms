import type { BarangayScope } from '../types/common';
import { claimToRole, type RoleCode } from './roles';

/**
 * AUTHORITATIVE permission matrix (docs/architecture/03-security.md §5 mirrors this).
 * Enforced server-side by Cloud Functions; used client-side only for UI visibility.
 */
export const PERMISSIONS = {
  'admin.users.manage': ['super_admin', 'municipal_accountant'],
  'admin.config.manage': ['super_admin', 'municipal_accountant'],
  'coa.manage': ['municipal_accountant'],
  'subsidiary.manage': ['municipal_accountant', 'accounting_reviewer', 'accounting_staff'],
  /** Barangay masters: bank accounts, accountable officers' ledgers, signatories, offices. */
  'barangay.setup': ['municipal_accountant', 'accounting_reviewer', 'accounting_staff', 'punong_barangay', 'barangay_treasurer'],
  'fiscalYear.manage': ['super_admin', 'municipal_accountant'],
  'period.lock': ['municipal_accountant', 'accounting_reviewer'],
  'period.reopen': ['municipal_accountant'],
  'budget.encode': ['municipal_accountant', 'accounting_staff', 'appropriations_chair', 'barangay_encoder'],
  'budget.certify': ['appropriations_chair'],
  'obligation.encode': ['barangay_treasurer', 'appropriations_chair', 'barangay_encoder'],
  'treasury.encode': ['barangay_treasurer', 'barangay_encoder'],
  'accountableForms.manage': ['accounting_staff', 'barangay_treasurer'],
  'treasury.submit': ['barangay_treasurer', 'appropriations_chair'],
  'transaction.approve': ['punong_barangay'],
  'submission.review': ['municipal_accountant', 'accounting_reviewer', 'accounting_staff'],
  'submission.accept': ['municipal_accountant', 'accounting_reviewer'],
  'jev.prepare': ['municipal_accountant', 'accounting_reviewer', 'accounting_staff'],
  'jev.review': ['municipal_accountant', 'accounting_reviewer'],
  'jev.approve': ['municipal_accountant'],
  'jev.post': ['municipal_accountant'],
  'jev.reverse': ['municipal_accountant'],
  'recon.prepare': ['municipal_accountant', 'accounting_reviewer', 'accounting_staff', 'barangay_treasurer'],
  'recon.finalize': ['municipal_accountant'],
  'property.manage': ['accounting_staff', 'property_officer'],
  'report.generate': [
    'municipal_accountant',
    'accounting_reviewer',
    'accounting_staff',
    'punong_barangay',
    'barangay_treasurer',
    'appropriations_chair',
    'property_officer',
    'barangay_encoder',
    'auditor',
  ],
  'report.submit': ['barangay_treasurer', 'appropriations_chair', 'property_officer'],
  'report.finalize': ['municipal_accountant'],
  'nfs.edit': ['municipal_accountant', 'accounting_reviewer'],
  'attachment.upload': [
    'municipal_accountant',
    'accounting_reviewer',
    'accounting_staff',
    'punong_barangay',
    'barangay_treasurer',
    'appropriations_chair',
    'property_officer',
    'barangay_encoder',
  ],
  'yearEnd.close': ['municipal_accountant'],
  'import.manage': ['municipal_accountant', 'accounting_reviewer', 'accounting_staff'],
  'import.approve': ['municipal_accountant'],
  'audit.read': ['super_admin', 'municipal_accountant', 'accounting_reviewer', 'auditor'],
  'read.transactions': [
    'municipal_accountant',
    'accounting_reviewer',
    'accounting_staff',
    'punong_barangay',
    'barangay_treasurer',
    'appropriations_chair',
    'property_officer',
    'barangay_encoder',
    'auditor',
  ],
} as const satisfies Record<string, readonly RoleCode[]>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Assignment-like input: either decoded claims or Firestore assignments. */
export interface ScopedRoles {
  scope: BarangayScope;
  roles: readonly RoleCode[];
}

export function permissionsForRole(role: RoleCode): Permission[] {
  return ALL_PERMISSIONS.filter((p) => (PERMISSIONS[p] as readonly RoleCode[]).includes(role));
}

/** Roles held at a barangay — includes roles held at scope 'ALL'. */
export function rolesAt(assignments: readonly ScopedRoles[], barangayId: BarangayScope): Set<RoleCode> {
  const out = new Set<RoleCode>();
  for (const a of assignments) {
    if (a.scope === 'ALL' || a.scope === barangayId) a.roles.forEach((r) => out.add(r));
  }
  return out;
}

export function canAccessBarangay(assignments: readonly ScopedRoles[], barangayId: BarangayScope): boolean {
  return assignments.some((a) => a.scope === 'ALL' || a.scope === barangayId);
}

export function hasPermission(
  assignments: readonly ScopedRoles[],
  permission: Permission,
  barangayId: BarangayScope,
): boolean {
  const allowed = PERMISSIONS[permission] as readonly RoleCode[];
  for (const r of rolesAt(assignments, barangayId)) if (allowed.includes(r)) return true;
  return false;
}

/** Decode the compact custom claim `{ a: { AGBOY: ['BT'] } }` into ScopedRoles. */
export function scopedRolesFromClaims(a: Record<string, readonly string[]> | undefined | null): ScopedRoles[] {
  if (!a) return [];
  return Object.entries(a).map(([scope, codes]) => ({
    scope: scope as BarangayScope,
    roles: codes.map((c) => claimToRole(c)).filter((r): r is RoleCode => !!r),
  }));
}
