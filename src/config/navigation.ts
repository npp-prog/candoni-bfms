import type { Permission } from '@bfms/shared';

export interface NavItem {
  path: string;
  label: string;
  /** Visible when the user holds this permission at the selected barangay (UI only; server enforces). */
  permission: Permission;
  phase: number;
  children?: Array<{ path: string; label: string; permission: Permission }>;
}

/** Main navigation (Section XCVII). `phase` > current build shows a "coming in Phase N" page. */
export const NAV: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', permission: 'report.generate', phase: 1 },
  { path: '/budget', label: 'Budget', permission: 'read.transactions', phase: 3 },
  { path: '/collections', label: 'Collections', permission: 'read.transactions', phase: 4 },
  { path: '/accountable-forms', label: 'Accountable Forms', permission: 'read.transactions', phase: 4 },
  { path: '/disbursements', label: 'Disbursements', permission: 'read.transactions', phase: 5 },
  { path: '/payroll', label: 'Payroll', permission: 'read.transactions', phase: 5 },
  { path: '/cash-advances', label: 'Cash Advances', permission: 'read.transactions', phase: 6 },
  { path: '/liquidations', label: 'Liquidations', permission: 'read.transactions', phase: 6 },
  { path: '/petty-cash', label: 'Petty Cash', permission: 'read.transactions', phase: 6 },
  { path: '/trust-funds', label: 'Trust Funds', permission: 'read.transactions', phase: 7 },
  { path: '/bank-reconciliation', label: 'Bank Reconciliation', permission: 'read.transactions', phase: 9 },
  { path: '/property', label: 'Property & Inventory', permission: 'read.transactions', phase: 10 },
  { path: '/accounting', label: 'Accounting', permission: 'read.transactions', phase: 1 },
  { path: '/reports', label: 'Reports', permission: 'report.generate', phase: 12 },
  { path: '/documents', label: 'Documents', permission: 'read.transactions', phase: 12 },
  { path: '/compliance', label: 'Compliance', permission: 'submission.review', phase: 12 },
  { path: '/admin', label: 'Administration', permission: 'admin.config.manage', phase: 1 },
];

export const CURRENT_PHASE = 1;
