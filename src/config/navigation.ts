import type { Permission } from '@bfms/shared';

export interface NavItem {
  path: string;
  label: string;
  /** Visible when the user holds this permission at the selected barangay (UI only; server enforces). */
  permission: Permission;
  phase: number;
  /** Section heading the item is grouped under in the sidebar. */
  group: 'Overview' | 'Budget & Treasury' | 'Accounting' | 'Property' | 'Reports' | 'Settings';
}

/** Main navigation (Section XCVII). Document uploads are intentionally not part of this build. */
export const NAV: NavItem[] = [
  { path: '/dashboard', label: 'Dashboard', permission: 'report.generate', phase: 1, group: 'Overview' },
  { path: '/budget', label: 'Budget', permission: 'read.transactions', phase: 3, group: 'Budget & Treasury' },
  { path: '/collections', label: 'Collections', permission: 'read.transactions', phase: 4, group: 'Budget & Treasury' },
  { path: '/accountable-forms', label: 'Accountable Forms', permission: 'read.transactions', phase: 4, group: 'Budget & Treasury' },
  { path: '/disbursements', label: 'Disbursements', permission: 'read.transactions', phase: 5, group: 'Budget & Treasury' },
  { path: '/payroll', label: 'Payroll', permission: 'read.transactions', phase: 5, group: 'Budget & Treasury' },
  { path: '/cash-advances', label: 'Cash Advances', permission: 'read.transactions', phase: 6, group: 'Budget & Treasury' },
  { path: '/liquidations', label: 'Liquidations', permission: 'read.transactions', phase: 6, group: 'Budget & Treasury' },
  { path: '/petty-cash', label: 'Petty Cash', permission: 'read.transactions', phase: 6, group: 'Budget & Treasury' },
  { path: '/trust-funds', label: 'Trust Funds', permission: 'read.transactions', phase: 7, group: 'Budget & Treasury' },
  { path: '/accounting', label: 'Journal Entries', permission: 'read.transactions', phase: 1, group: 'Accounting' },
  { path: '/books', label: 'Books of Accounts', permission: 'read.transactions', phase: 8, group: 'Accounting' },
  { path: '/bank-reconciliation', label: 'Bank Reconciliation', permission: 'read.transactions', phase: 9, group: 'Accounting' },
  { path: '/statements', label: 'Financial Statements', permission: 'report.generate', phase: 11, group: 'Accounting' },
  { path: '/property', label: 'Property & Inventory', permission: 'read.transactions', phase: 10, group: 'Property' },
  { path: '/reports', label: 'Report Center', permission: 'report.generate', phase: 12, group: 'Reports' },
  { path: '/compliance', label: 'Monthly Submission', permission: 'report.generate', phase: 12, group: 'Reports' },
  { path: '/setup', label: 'Barangay Setup', permission: 'barangay.setup', phase: 3, group: 'Settings' },
  { path: '/admin', label: 'Administration', permission: 'admin.config.manage', phase: 1, group: 'Settings' },
];

export const CURRENT_PHASE = 12;
