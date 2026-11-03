/**
 * The app runs as the barangay ACCOUNTING system: the Municipal Accounting Office keeps each
 * barangay's books from the documents the barangay submits. The transaction-processing modules
 * (budget, collections, disbursements, payroll, petty cash, trust funds, property transactions,
 * monthly submission) are hidden but kept in the code; set VITE_ENABLE_TRANSACTION_MODULES=true
 * to show them again.
 */
export const TRANSACTION_MODULES_ENABLED = import.meta.env.VITE_ENABLE_TRANSACTION_MODULES === 'true';

const HIDDEN_PATHS = [
  '/budget',
  '/collections',
  '/accountable-forms',
  '/disbursements',
  '/payroll',
  '/cash-advances',
  '/liquidations',
  '/petty-cash',
  '/trust-funds',
  '/property',
  '/compliance',
];

/** Route/menu paths that belong to the hidden transaction modules. */
export function isTransactionPath(path: string): boolean {
  const p = path.replace(/\/\*$/, '');
  return HIDDEN_PATHS.some((h) => p === h || p.startsWith(`${h}/`));
}

export function pathEnabled(path: string): boolean {
  return TRANSACTION_MODULES_ENABLED || !isTransactionPath(path);
}
