import { ROUTES as BANK } from './bank/routes';
import { ROUTES as BOOKS } from './books/routes';
import { ROUTES as BUDGET } from './budget/routes';
import { ROUTES as CASH_ADVANCES } from './cashAdvances/routes';
import { ROUTES as COLLECTIONS } from './collections/routes';
import { ROUTES as DISBURSEMENTS } from './disbursements/routes';
import { ROUTES as PROPERTY } from './property/routes';
import { ROUTES as REPORT_CENTER } from './reportCenter/routes';
import { ROUTES as SETUP } from './setup/routes';
import type { ModuleRoute } from './types';

/** Every module's routes. Each phase owns its folder under src/modules/. */
export const MODULE_ROUTES: ModuleRoute[] = [...BUDGET, ...COLLECTIONS, ...DISBURSEMENTS, ...CASH_ADVANCES, ...BOOKS, ...BANK, ...PROPERTY, ...REPORT_CENTER, ...SETUP];
