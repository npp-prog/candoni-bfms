import { registerSourceModules } from '../sources/engine';
import { BANK_SERVER_MODULES } from './bank';
import { BOOKS_SERVER_MODULES } from './books';
import { BUDGET_SERVER_MODULES } from './budget';
import { CASH_ADVANCES_SERVER_MODULES } from './cashAdvances';
import { COLLECTIONS_SERVER_MODULES } from './collections';
import { DISBURSEMENTS_SERVER_MODULES } from './disbursements';
import { PROPERTY_SERVER_MODULES } from './property';

registerSourceModules([
  ...BUDGET_SERVER_MODULES,
  ...COLLECTIONS_SERVER_MODULES,
  ...DISBURSEMENTS_SERVER_MODULES,
  ...CASH_ADVANCES_SERVER_MODULES,
  ...BOOKS_SERVER_MODULES,
  ...BANK_SERVER_MODULES,
  ...PROPERTY_SERVER_MODULES,
]);
