import { BANK_MODULES } from './bank';
import { BOOKS_MODULES } from './books';
import { BUDGET_MODULES } from './budget';
import { CASH_ADVANCES_MODULES } from './cashAdvances';
import { COLLECTIONS_MODULES } from './collections';
import { DISBURSEMENTS_MODULES } from './disbursements';
import { PROPERTY_MODULES } from './property';
import type { SourceModuleDef } from './types';

/** Every source-document module, keyed by `key`. Each phase owns its own file. */
export const SOURCE_MODULES: readonly SourceModuleDef[] = [
  ...BUDGET_MODULES,
  ...COLLECTIONS_MODULES,
  ...DISBURSEMENTS_MODULES,
  ...CASH_ADVANCES_MODULES,
  ...BOOKS_MODULES,
  ...BANK_MODULES,
  ...PROPERTY_MODULES,
];

export function sourceModule(key: string): SourceModuleDef {
  const m = SOURCE_MODULES.find((x) => x.key === key);
  if (!m) throw new Error(`Unknown source module ${key}`);
  return m;
}
