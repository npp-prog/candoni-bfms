export const ROLES = {
  super_admin: { claim: 'SA', label: 'Super Admin', scopes: ['ALL'] },
  municipal_accountant: { claim: 'MA', label: 'Municipal Accountant', scopes: ['ALL'] },
  accounting_reviewer: { claim: 'AR', label: 'Accounting Reviewer', scopes: ['ALL'] },
  accounting_staff: { claim: 'AS', label: 'Accounting Staff', scopes: ['ALL', 'BARANGAY'] },
  punong_barangay: { claim: 'PB', label: 'Punong Barangay', scopes: ['BARANGAY'] },
  barangay_treasurer: { claim: 'BT', label: 'Barangay Treasurer', scopes: ['BARANGAY'] },
  appropriations_chair: {
    claim: 'AC',
    label: 'Chairperson, Committee on Appropriations',
    scopes: ['BARANGAY'],
  },
  property_officer: { claim: 'PO', label: 'Property / Inventory Officer', scopes: ['BARANGAY'] },
  barangay_encoder: { claim: 'BE', label: 'Barangay Encoder', scopes: ['BARANGAY'] },
  auditor: { claim: 'AU', label: 'Auditor / Read-only', scopes: ['ALL', 'BARANGAY'] },
} as const satisfies Record<string, { claim: string; label: string; scopes: readonly ('ALL' | 'BARANGAY')[] }>;

export type RoleCode = keyof typeof ROLES;
export type ClaimCode = (typeof ROLES)[RoleCode]['claim'];

export const ROLE_CODES = Object.keys(ROLES) as RoleCode[];

export const CLAIM_TO_ROLE: Record<ClaimCode, RoleCode> = Object.fromEntries(
  ROLE_CODES.map((r) => [ROLES[r].claim, r]),
) as Record<ClaimCode, RoleCode>;

export function roleToClaim(role: RoleCode): ClaimCode {
  return ROLES[role].claim;
}

export function claimToRole(claim: string): RoleCode | undefined {
  return (CLAIM_TO_ROLE as Record<string, RoleCode>)[claim];
}

/** Roles only a Super Admin may grant (MA may grant the rest). */
export const PRIVILEGED_ROLES: readonly RoleCode[] = [
  'super_admin',
  'municipal_accountant',
  'accounting_reviewer',
];

export function isRoleAllowedAtScope(role: RoleCode, scope: string): boolean {
  const scopes = ROLES[role].scopes as readonly string[];
  return scope === 'ALL' ? scopes.includes('ALL') : scopes.includes('BARANGAY');
}
