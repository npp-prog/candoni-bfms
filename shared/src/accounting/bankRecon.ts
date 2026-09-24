import type { ReconItem, ReconItemCategory } from '../types/bank';
import type { Centavos } from '../types/common';
import { BfmsError } from './errors';
import { assertCentavos } from './money';

export interface ReconTotals {
  depositInTransit: Centavos;
  outstandingChecks: Centavos;
  debitMemos: Centavos;
  creditMemos: Centavos;
  bankCharges: Centavos;
  interestIncome: Centavos;
  bookErrors: Centavos;
  bankErrors: Centavos;
  otherBookItems: Centavos;
  otherBankItems: Centavos;
}

const CATEGORY_FIELD: Record<ReconItemCategory, keyof ReconTotals> = {
  DEPOSIT_IN_TRANSIT: 'depositInTransit',
  OUTSTANDING_CHECK: 'outstandingChecks',
  BANK_DEBIT_MEMO: 'debitMemos',
  BANK_CREDIT_MEMO: 'creditMemos',
  BANK_CHARGES: 'bankCharges',
  INTEREST_INCOME: 'interestIncome',
  BOOK_ERROR: 'bookErrors',
  BANK_ERROR: 'bankErrors',
  OTHER_BOOK: 'otherBookItems',
  OTHER_BANK: 'otherBankItems',
};

export function totalReconItems(items: readonly Pick<ReconItem, 'category' | 'amount'>[]): ReconTotals {
  const t: ReconTotals = {
    depositInTransit: 0 as Centavos,
    outstandingChecks: 0 as Centavos,
    debitMemos: 0 as Centavos,
    creditMemos: 0 as Centavos,
    bankCharges: 0 as Centavos,
    interestIncome: 0 as Centavos,
    bookErrors: 0 as Centavos,
    bankErrors: 0 as Centavos,
    otherBookItems: 0 as Centavos,
    otherBankItems: 0 as Centavos,
  };
  for (const i of items) {
    const f = CATEGORY_FIELD[i.category];
    t[f] = (t[f] + assertCentavos(i.amount)) as Centavos;
  }
  return t;
}

/**
 * Bank Reconciliation Statement (two-sided / "adjusted balance" method), matching the legacy
 * "STATEMENT OF BANK RECONCILIATION":
 *   Adjusted Book = Book + Credit Memos + Interest − Debit Memos − Bank Charges ± Book errors ± Other book
 *   Adjusted Bank = Bank + Deposits in Transit − Outstanding Checks ± Bank errors ± Other bank
 * Unsigned categories are entered positive; error/other categories are signed.
 */
export function computeBankReconciliation(bookBalance: Centavos, bankBalance: Centavos, t: ReconTotals) {
  assertCentavos(bookBalance, 'bookBalance');
  assertCentavos(bankBalance, 'bankBalance');
  for (const k of ['depositInTransit', 'outstandingChecks', 'debitMemos', 'creditMemos', 'bankCharges', 'interestIncome'] as const)
    if (t[k] < 0) throw new BfmsError('VALIDATION_FAILED', `${k} must not be negative.`);
  const adjustedBookBalance = (bookBalance + t.creditMemos + t.interestIncome - t.debitMemos - t.bankCharges + t.bookErrors + t.otherBookItems) as Centavos;
  const adjustedBankBalance = (bankBalance + t.depositInTransit - t.outstandingChecks + t.bankErrors + t.otherBankItems) as Centavos;
  const difference = (adjustedBookBalance - adjustedBankBalance) as Centavos;
  return { adjustedBookBalance, adjustedBankBalance, difference, balanced: difference === 0 };
}

export function assertReconciliationBalanced(difference: Centavos): void {
  if (difference !== 0)
    throw new BfmsError('RECONCILIATION_NOT_BALANCED', 'Adjusted book balance must equal adjusted bank balance before finalizing.', {
      difference,
    });
}
