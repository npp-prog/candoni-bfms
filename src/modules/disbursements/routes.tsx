import type { ModuleRoute } from '../types';
import { DisbursementsPage } from './DisbursementsPage';
import { PayrollPage } from './PayrollPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [
  { path: '/disbursements/*', element: <DisbursementsPage />, permission: 'read.transactions' },
  { path: '/payroll/*', element: <PayrollPage />, permission: 'read.transactions' },
];
