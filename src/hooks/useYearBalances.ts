import type { AccountBalanceDoc, BarangayId } from '@bfms/shared';
import { useMemo } from 'react';
import { useCollection } from './useCollection';

/** Posted activity of one account (or one subsidiary ledger) for a fiscal year, as Dr − Cr. */
export interface YearBalance {
  /** Opening balance (period 00). */
  beginning: number;
  /** Debits and credits of January–December (closing entries excluded). */
  debit: number;
  credit: number;
  /** Pre-closing balance at December 31 = beginning + debit − credit. */
  ending: number;
}

export interface YearBalances {
  loading: boolean;
  /** Roll-up per account code. */
  byAccount: Map<string, YearBalance>;
  /** Per subsidiary ledger (subsidiaryAccounts document id). */
  bySubsidiary: Map<string, YearBalance>;
}

const add = (m: Map<string, YearBalance>, k: string, b: AccountBalanceDoc) => {
  let v = m.get(k);
  if (!v) m.set(k, (v = { beginning: 0, debit: 0, credit: 0, ending: 0 }));
  if (b.month === 0) v.beginning += b.debit - b.credit;
  else {
    v.debit += b.debit;
    v.credit += b.credit;
  }
  v.ending = v.beginning + v.debit - v.credit;
};

/**
 * The fiscal year's posted balances of a barangay, from the accountBalances period aggregates:
 * opening (period 00) and January–December. Closing entries (period 13) are left out, so the
 * ending balance is the pre-closing balance, as in the legacy 02.1_TB_DB.
 */
export function useYearBalances(barangayId: BarangayId | null, fiscalYear: number): YearBalances {
  const { rows, loading } = useCollection<AccountBalanceDoc>(
    'accountBalances',
    barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null,
    // One row per account / ledger / period / fund: a barangay year runs to a few thousand.
    { limit: 20000 },
  );
  return useMemo(() => {
    const byAccount = new Map<string, YearBalance>();
    const bySubsidiary = new Map<string, YearBalance>();
    for (const b of rows) {
      if (b.month < 0 || b.month > 12) continue;
      if (b.subsidiaryId === null) add(byAccount, b.accountCode, b);
      else add(bySubsidiary, b.subsidiaryId, b);
    }
    return { loading, byAccount, bySubsidiary };
  }, [rows, loading]);
}

/** A Dr − Cr amount shown on the account's normal side (negative = abnormal balance). */
export const onNormalSide = (amount: number, normalBalance: 'DEBIT' | 'CREDIT' | undefined) => (normalBalance === 'CREDIT' ? -amount : amount);
