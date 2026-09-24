import { describe, expect, it } from 'vitest';
import {
  canAccessBarangay,
  hasPermission,
  isRoleAllowedAtScope,
  permissionsForRole,
  REPORT_DEFINITIONS,
  ROLE_CODES,
  scopedRolesFromClaims,
} from '../src';

describe('permission matrix', () => {
  const treasurerAgboy = scopedRolesFromClaims({ AGBOY: ['BT'] });
  const accountant = scopedRolesFromClaims({ ALL: ['MA'] });
  const superAdmin = scopedRolesFromClaims({ ALL: ['SA'] });

  it('isolates barangay users to their own barangay', () => {
    expect(canAccessBarangay(treasurerAgboy, 'AGBOY')).toBe(true);
    for (const b of ['BANGA', 'CABIA-AN', 'CANINGAY', 'EAST', 'GATUSLAO', 'HABA', 'PAYAUAN', 'WEST'] as const)
      expect(canAccessBarangay(treasurerAgboy, b)).toBe(false);
    expect(hasPermission(treasurerAgboy, 'treasury.encode', 'BANGA')).toBe(false);
  });

  it('treasurer can encode and submit but never post, lock or approve JEVs', () => {
    expect(hasPermission(treasurerAgboy, 'treasury.encode', 'AGBOY')).toBe(true);
    expect(hasPermission(treasurerAgboy, 'treasury.submit', 'AGBOY')).toBe(true);
    for (const p of ['jev.post', 'jev.approve', 'period.lock', 'period.reopen', 'coa.manage', 'recon.finalize'] as const)
      expect(hasPermission(treasurerAgboy, p, 'AGBOY')).toBe(false);
  });

  it('municipal accountant reaches all nine barangays', () => {
    expect(hasPermission(accountant, 'jev.post', 'WEST')).toBe(true);
    expect(hasPermission(accountant, 'period.reopen', 'HABA')).toBe(true);
  });

  it('super admin manages users/config but has no accounting authority by default', () => {
    expect(hasPermission(superAdmin, 'admin.users.manage', 'ALL')).toBe(true);
    for (const p of ['jev.post', 'jev.reverse', 'read.transactions', 'period.reopen'] as const)
      expect(hasPermission(superAdmin, p, 'AGBOY')).toBe(false);
  });

  it('auditor is read-only', () => {
    const auditor = permissionsForRole('auditor');
    expect(auditor.sort()).toEqual(['audit.read', 'read.transactions', 'report.generate'].sort());
  });

  it('scope constraints', () => {
    expect(isRoleAllowedAtScope('barangay_treasurer', 'ALL')).toBe(false);
    expect(isRoleAllowedAtScope('municipal_accountant', 'AGBOY')).toBe(false);
    expect(isRoleAllowedAtScope('accounting_staff', 'AGBOY')).toBe(true);
    expect(ROLE_CODES).toHaveLength(10);
  });
});

describe('report catalog', () => {
  it('covers all 50 prescribed forms with unique codes', () => {
    const forms = REPORT_DEFINITIONS.filter((r) => r.formNumber !== null).map((r) => r.formNumber);
    expect(new Set(forms).size).toBe(50);
    expect(Math.min(...(forms as number[]))).toBe(1);
    expect(Math.max(...(forms as number[]))).toBe(50);
    expect(new Set(REPORT_DEFINITIONS.map((r) => r.reportCode)).size).toBe(REPORT_DEFINITIONS.length);
  });
  it('does not assign every report to the treasurer', () => {
    const byCode = Object.fromEntries(REPORT_DEFINITIONS.map((r) => [r.reportCode, r]));
    expect(byCode.RAO?.preparedByRole).toBe('appropriations_chair');
    expect(byCode.GL?.preparedByRole).toBe('municipal_accountant');
    expect(byCode.CASHBOOK?.preparedByRole).toBe('barangay_treasurer');
    expect(byCode.SFP?.responsibleOffice).toBe('MUNICIPAL_ACCOUNTING');
  });
});
