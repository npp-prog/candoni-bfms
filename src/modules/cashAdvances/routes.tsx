import type { ModuleRoute } from '../types';
import { CashAdvancesPage } from './CashAdvancesPage';
import { LiquidationsPage } from './LiquidationsPage';
import { PettyCashPage } from './PettyCashPage';
import { TrustFundsPage } from './TrustFundsPage';

/** Routes this module adds under the app shell (Phases 6–7). */
export const ROUTES: ModuleRoute[] = [
  { path: '/cash-advances/*', element: <CashAdvancesPage />, permission: 'read.transactions' },
  { path: '/liquidations/*', element: <LiquidationsPage />, permission: 'read.transactions' },
  { path: '/petty-cash/*', element: <PettyCashPage />, permission: 'read.transactions' },
  { path: '/trust-funds/*', element: <TrustFundsPage />, permission: 'read.transactions' },
];
