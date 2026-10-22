import type { ModuleRoute } from '../types';
import { BankPage } from './BankPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [{ path: '/bank-reconciliation/*', element: <BankPage />, permission: 'read.transactions' }];
