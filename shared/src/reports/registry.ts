import { BANK_REPORTS } from './builders/bank';
import { BOOKS_REPORTS } from './builders/books';
import { BUDGET_REPORTS } from './builders/budget';
import { CASH_ADVANCES_REPORTS } from './builders/cashAdvances';
import { COLLECTIONS_REPORTS } from './builders/collections';
import { COMPLIANCE_REPORTS } from './builders/compliance';
import { DISBURSEMENTS_REPORTS } from './builders/disbursements';
import { PROPERTY_REPORTS } from './builders/property';
import type { ReportBuilder } from './context';

/** Every implemented report builder. A report code without a builder shows as "not yet available". */
export const REPORT_BUILDERS: readonly ReportBuilder[] = [
  ...BUDGET_REPORTS,
  ...COLLECTIONS_REPORTS,
  ...DISBURSEMENTS_REPORTS,
  ...CASH_ADVANCES_REPORTS,
  ...BOOKS_REPORTS,
  ...BANK_REPORTS,
  ...PROPERTY_REPORTS,
  ...COMPLIANCE_REPORTS,
];

export function reportBuilder(code: string): ReportBuilder | undefined {
  return REPORT_BUILDERS.find((b) => b.code === code);
}
