import type { Centavos } from '../types/common';

/** Statement of Financial Position equation (Section LVIII). */
export function checkFinancialPosition(totalAssets: Centavos, totalLiabilities: Centavos, netAssetsEquity: Centavos) {
  const difference = (totalAssets - (totalLiabilities + netAssetsEquity)) as Centavos;
  return { difference, balanced: difference === 0 };
}

/** Statement of Cash Flows: beginning + net change = ending = Σ cash accounts. */
export function checkCashFlow(input: {
  beginningCash: Centavos;
  operating: Centavos;
  investing: Centavos;
  financing: Centavos;
  cashAccountsEnding: Centavos;
}) {
  const netChange = (input.operating + input.investing + input.financing) as Centavos;
  const endingCash = (input.beginningCash + netChange) as Centavos;
  const difference = (endingCash - input.cashAccountsEnding) as Centavos;
  return { netChange, endingCash, difference, reconciled: difference === 0 };
}

/** Statement of Changes in Net Assets/Equity (legacy SCNA layout). */
export function computeNetAssetsChanges(input: {
  beginningBalance: Centavos;
  priorPeriodAdjustments: Centavos;
  changesInAccountingPolicy: Centavos;
  surplusDeficit: Centavos;
  otherAdjustments?: Centavos;
}) {
  const restatedBalance = (input.beginningBalance + input.priorPeriodAdjustments + input.changesInAccountingPolicy) as Centavos;
  const endingBalance = (restatedBalance + input.surplusDeficit + (input.otherAdjustments ?? 0)) as Centavos;
  return { restatedBalance, endingBalance };
}

/** Straight-line depreciation (legacy PPE schedule: (cost − residual) / life). Monthly amount in centavos. */
export function monthlyDepreciation(cost: Centavos, residual: Centavos, usefulLifeYears: number): Centavos {
  if (usefulLifeYears <= 0) return 0 as Centavos;
  const depreciable = cost - residual;
  if (depreciable <= 0) return 0 as Centavos;
  return Math.round(depreciable / (usefulLifeYears * 12)) as Centavos;
}

/**
 * Depreciation for one month, capped so accumulated never exceeds the depreciable amount
 * (the last month absorbs rounding).
 */
export function depreciationForMonth(cost: Centavos, residual: Centavos, usefulLifeYears: number, accumulatedSoFar: Centavos): Centavos {
  const depreciable = Math.max(0, cost - residual);
  const remaining = depreciable - accumulatedSoFar;
  if (remaining <= 0) return 0 as Centavos;
  return Math.min(remaining, monthlyDepreciation(cost, residual, usefulLifeYears)) as Centavos;
}
