import type { Centavos } from '../types/common';
import { BfmsError } from './errors';
import { assertCentavos } from './money';

export interface AppropriationFigures {
  originalAppropriation: Centavos;
  supplementalAppropriation: Centavos;
  realignment: Centavos; // signed
  adjustments: Centavos; // signed
  obligations: Centavos;
}

/** Server-side appropriation arithmetic (Section XVI). Never trust client-sent totals. */
export function computeAppropriationBalance(a: AppropriationFigures): {
  totalAppropriation: Centavos;
  availableBalance: Centavos;
  utilizationBp: number;
} {
  const o = assertCentavos(a.originalAppropriation, 'originalAppropriation');
  const s = assertCentavos(a.supplementalAppropriation, 'supplementalAppropriation');
  const r = assertCentavos(a.realignment, 'realignment');
  const adj = assertCentavos(a.adjustments, 'adjustments');
  const ob = assertCentavos(a.obligations, 'obligations');
  if (o < 0 || s < 0 || ob < 0) throw new BfmsError('VALIDATION_FAILED', 'Appropriation and obligation amounts cannot be negative.');
  const totalAppropriation = (o + s + r + adj) as Centavos;
  if (totalAppropriation < 0) throw new BfmsError('VALIDATION_FAILED', 'Total appropriation cannot be negative.');
  const availableBalance = (totalAppropriation - ob) as Centavos;
  const utilizationBp = totalAppropriation === 0 ? 0 : Math.round((ob * 10000) / totalAppropriation);
  return { totalAppropriation, availableBalance, utilizationBp };
}

/** Certification gate (Section XXVII): AVAILABLE APPROPRIATION ≥ OBLIGATION. */
export function assertAppropriationAvailable(available: Centavos, obligation: Centavos): void {
  assertCentavos(obligation, 'obligation');
  if (obligation <= 0) throw new BfmsError('VALIDATION_FAILED', 'Obligation amount must be greater than zero.');
  if (obligation > available)
    throw new BfmsError('INSUFFICIENT_APPROPRIATION', 'Obligation exceeds the available appropriation.', {
      available,
      obligation,
      shortBy: obligation - available,
    });
}

/** STF gate (Section XXXV). */
export function computeStfBalance(f: { amountReceived: Centavos; adjustments: Centavos; amountObligated: Centavos }): Centavos {
  return (f.amountReceived + f.adjustments - f.amountObligated) as Centavos;
}

export function assertStfAvailable(balance: Centavos, charge: Centavos): void {
  if (charge > balance)
    throw new BfmsError('INSUFFICIENT_STF_BALANCE', 'Charge exceeds the available Special Trust Fund balance.', {
      balance,
      charge,
    });
}

/** REAI realization. */
export function computeRealization(estimated: Centavos, monthlyActual: readonly Centavos[]) {
  const ytd = monthlyActual.reduce((t, v) => t + v, 0) as Centavos;
  return {
    yearToDateActual: ytd,
    variance: (ytd - estimated) as Centavos,
    collectionRateBp: estimated === 0 ? 0 : Math.round((ytd * 10000) / estimated),
  };
}
