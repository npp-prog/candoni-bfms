import type { CashAdvanceStatus } from '../constants/statuses';
import type { Centavos, IsoDate } from '../types/common';
import { BfmsError } from './errors';
import { assertCentavos } from './money';
import { assertIsoDate } from './periods';

/** Default aging buckets (days). Configurable in systemSettings/aging. */
export const DEFAULT_AGING_BUCKETS: ReadonlyArray<{ maxDays: number; label: string }> = [
  { maxDays: 30, label: '0-30 days' },
  { maxDays: 60, label: '31-60 days' },
  { maxDays: 90, label: '61-90 days' },
  { maxDays: 180, label: '91-180 days' },
  { maxDays: 365, label: '181-365 days' },
  { maxDays: Number.POSITIVE_INFINITY, label: 'Over 1 year' },
];

export function daysBetween(from: IsoDate, to: IsoDate): number {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function agingCategory(days: number, buckets = DEFAULT_AGING_BUCKETS): string {
  const b = buckets.find((x) => days <= x.maxDays);
  return b?.label ?? buckets[buckets.length - 1]!.label;
}

export interface CashAdvanceFigures {
  amountGranted: Centavos;
  amountLiquidated: Centavos;
  amountRefunded: Centavos;
  grantDate: IsoDate;
  liquidationDueDate: IsoDate;
}

/** outstanding = granted − liquidated − refunded (Section XXXI). */
export function computeCashAdvanceBalance(ca: CashAdvanceFigures, asOf: IsoDate, buckets = DEFAULT_AGING_BUCKETS) {
  const g = assertCentavos(ca.amountGranted, 'amountGranted');
  const l = assertCentavos(ca.amountLiquidated, 'amountLiquidated');
  const r = assertCentavos(ca.amountRefunded, 'amountRefunded');
  if (g <= 0) throw new BfmsError('VALIDATION_FAILED', 'Cash advance amount must be greater than zero.');
  if (l < 0 || r < 0) throw new BfmsError('VALIDATION_FAILED', 'Liquidated and refunded amounts cannot be negative.');
  const outstandingBalance = (g - l - r) as Centavos;
  if (outstandingBalance < 0)
    throw new BfmsError('LIQUIDATION_NOT_RECONCILED', 'Liquidations and refunds exceed the cash advance granted.', {
      excess: -outstandingBalance,
    });
  const daysOutstanding = Math.max(0, daysBetween(ca.grantDate, asOf));
  let status: CashAdvanceStatus;
  if (outstandingBalance === 0) status = 'FULLY_LIQUIDATED';
  else if (asOf > ca.liquidationDueDate) status = 'OVERDUE';
  else if (l + r > 0) status = 'PARTIALLY_LIQUIDATED';
  else status = 'ACTIVE';
  return {
    outstandingBalance,
    daysOutstanding,
    agingCategory: outstandingBalance === 0 ? 'Liquidated' : agingCategory(daysOutstanding, buckets),
    status,
  };
}

/**
 * Liquidation Report arithmetic (Section XXXIII):
 *   Cash Advance − Supported Expenditures − Cash Refunded = Balance Remaining
 * FULLY_LIQUIDATED only if balance is zero.
 */
export function computeLiquidation(input: {
  cashAdvanceOutstanding: Centavos;
  itemAmounts: readonly Centavos[];
  cashRefunded: Centavos;
}) {
  const items = input.itemAmounts.map((a, i) => assertCentavos(a, `item ${i + 1}`));
  if (items.some((a) => a <= 0)) throw new BfmsError('VALIDATION_FAILED', 'Every liquidation item must be greater than zero.');
  const totalSupported = items.reduce((t, a) => t + a, 0) as Centavos;
  const refund = assertCentavos(input.cashRefunded, 'cashRefunded');
  if (refund < 0) throw new BfmsError('VALIDATION_FAILED', 'Refund cannot be negative.');
  const balanceRemaining = (input.cashAdvanceOutstanding - totalSupported - refund) as Centavos;
  if (balanceRemaining < 0)
    throw new BfmsError(
      'LIQUIDATION_NOT_RECONCILED',
      'Supported expenditures and refund exceed the outstanding cash advance. Excess must be reimbursed through a separate DV.',
      { excess: -balanceRemaining },
    );
  return { totalSupported, balanceRemaining, fullyLiquidated: balanceRemaining === 0 };
}
