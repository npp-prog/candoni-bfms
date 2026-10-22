import type { ModuleRoute } from '../types';
import { BudgetPage } from './BudgetPage';

/** Routes this module adds under the app shell. */
export const ROUTES: ModuleRoute[] = [{ path: '/budget/*', element: <BudgetPage />, permission: 'read.transactions' }];
