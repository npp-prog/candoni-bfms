import type { Centavos, IsoDate } from '../types/common';
import { sum } from './money';

export interface CashbookSourceLine {
  date: IsoDate;
  sortKey: string; // stable tiebreak (e.g. time + reference)
  reference: string;
  particulars: string;
  receipt: Centavos;
  payment: Centavos;
}

export interface CashbookRow extends CashbookSourceLine {
  balance: Centavos;
}

/**
 * Cashbook with running balance (Section XXIV). Rows are DERIVED from authorized transactions;
 * no independent balance is stored. Validation: beginning + receipts − payments = ending.
 */
export function buildCashbook(beginningBalance: Centavos, lines: readonly CashbookSourceLine[]) {
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.sortKey.localeCompare(b.sortKey));
  let bal = beginningBalance as number;
  const rows: CashbookRow[] = sorted.map((l) => {
    bal += l.receipt - l.payment;
    return { ...l, balance: bal as Centavos };
  });
  const totalReceipts = sum(sorted.map((l) => l.receipt));
  const totalPayments = sum(sorted.map((l) => l.payment));
  const endingBalance = (beginningBalance + totalReceipts - totalPayments) as Centavos;
  return {
    rows,
    beginningBalance,
    totalReceipts,
    totalPayments,
    endingBalance,
    /** Cross-check: last running balance equals the arithmetic ending balance. */
    valid: (rows.at(-1)?.balance ?? beginningBalance) === endingBalance,
    negativeBalanceDates: rows.filter((r) => r.balance < 0).map((r) => r.date),
  };
}

/** RCD validation (Section XXII): total collections vs total deposits. */
export function validateRcd(totalCollections: Centavos, totalDeposits: Centavos, explanation: string | null) {
  const undeposited = (totalCollections - totalDeposits) as Centavos;
  if (undeposited === 0) return { result: 'PASSED' as const, undeposited };
  if (undeposited < 0) return { result: 'FAILED' as const, undeposited, message: 'Deposits exceed collections.' };
  if (explanation && explanation.trim().length >= 10)
    return { result: 'WARNING' as const, undeposited, message: 'Undeposited collections explained.' };
  return { result: 'FAILED' as const, undeposited, message: 'Undeposited collections require an explanation.' };
}
