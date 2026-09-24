import type { AccountBalanceDoc } from '../types/accounting';
import type { ChartOfAccountDoc } from '../types/coa';
import type { BarangayId, Centavos, FundId } from '../types/common';
import { normalSignedBalance } from './journal';
import { sum } from './money';

/** accountBalances document id — period movements, one per (period, fund, account, SL). */
export function accountBalanceId(
  barangayId: BarangayId,
  fiscalYear: number,
  month: number,
  fundId: FundId,
  accountCode: string,
  subsidiaryId: string | null,
): string {
  return [barangayId, fiscalYear, String(month).padStart(2, '0'), fundId, accountCode, subsidiaryId ?? '-'].join('_');
}

export interface BalanceDelta {
  id: string;
  accountCode: string;
  subsidiaryId: string | null;
  debit: Centavos;
  credit: Centavos;
  lineCount: number;
}

/**
 * Aggregate JEV lines into balance increments. Each line contributes to:
 *   - the account roll-up row (subsidiaryId = null)
 *   - the SL row (when subsidiaryId set)
 * Written in the same transaction ⇒ Σ SL rows == roll-up for SL accounts by construction.
 */
export function balanceDeltas(
  barangayId: BarangayId,
  fiscalYear: number,
  month: number,
  fundId: FundId,
  lines: readonly { accountCode: string; subsidiaryId?: string | null; debit: Centavos; credit: Centavos }[],
): BalanceDelta[] {
  const map = new Map<string, BalanceDelta>();
  const bump = (accountCode: string, sl: string | null, d: Centavos, c: Centavos) => {
    const id = accountBalanceId(barangayId, fiscalYear, month, fundId, accountCode, sl);
    const cur = map.get(id) ?? { id, accountCode, subsidiaryId: sl, debit: 0 as Centavos, credit: 0 as Centavos, lineCount: 0 };
    cur.debit = (cur.debit + d) as Centavos;
    cur.credit = (cur.credit + c) as Centavos;
    cur.lineCount += 1;
    map.set(id, cur);
  };
  for (const l of lines) {
    bump(l.accountCode, null, l.debit, l.credit);
    if (l.subsidiaryId) bump(l.accountCode, l.subsidiaryId, l.debit, l.credit);
  }
  return [...map.values()];
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  debit: Centavos; // presentation column
  credit: Centavos; // presentation column
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: Centavos;
  totalCredit: Centavos;
  balanced: boolean;
}

/**
 * Trial Balance from account roll-up balance rows (subsidiaryId === null) for months in range.
 * Net balance goes to the side it naturally falls on; negative normal balances appear on the
 * opposite column (e.g. overdrawn cash shows as credit) — mirrors legacy practice but is flagged.
 */
export function buildTrialBalance(
  balances: readonly Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit' | 'month'>[],
  accounts: ReadonlyMap<string, Pick<ChartOfAccountDoc, 'accountName' | 'normalBalance' | 'sortOrder'>>,
  /** includeClosing = Post-Closing TB (months 00–13); otherwise months fromMonth..throughMonth. */
  opts: { throughMonth: number; includeClosing?: boolean; fromMonth?: number } = { throughMonth: 12 },
): TrialBalance {
  const from = opts.fromMonth ?? 0;
  const through = opts.includeClosing ? 13 : opts.throughMonth;
  const net = new Map<string, { d: number; c: number }>();
  for (const b of balances) {
    if (b.subsidiaryId !== null) continue;
    if (b.month < from || b.month > through) continue;
    const cur = net.get(b.accountCode) ?? { d: 0, c: 0 };
    cur.d += b.debit;
    cur.c += b.credit;
    net.set(b.accountCode, cur);
  }
  const rows: TrialBalanceRow[] = [];
  for (const [code, { d, c }] of net) {
    const a = accounts.get(code);
    const diff = d - c;
    if (diff === 0) continue;
    rows.push({
      accountCode: code,
      accountName: a?.accountName ?? '(unknown account)',
      normalBalance: a?.normalBalance ?? 'DEBIT',
      debit: (diff > 0 ? diff : 0) as Centavos,
      credit: (diff < 0 ? -diff : 0) as Centavos,
    });
  }
  rows.sort((x, y) => (accounts.get(x.accountCode)?.sortOrder ?? 0) - (accounts.get(y.accountCode)?.sortOrder ?? 0) || x.accountCode.localeCompare(y.accountCode));
  const totalDebit = sum(rows.map((r) => r.debit));
  const totalCredit = sum(rows.map((r) => r.credit));
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

/** Rows whose balance falls on the side opposite their normal balance (e.g. negative cash). */
export function abnormalBalances(tb: TrialBalance): TrialBalanceRow[] {
  return tb.rows.filter((r) => (r.normalBalance === 'DEBIT' ? r.credit > 0 : r.debit > 0));
}

/** SL ↔ GL reconciliation for one account: Σ SL rows vs roll-up row. */
export function reconcileSubsidiaries(
  balances: readonly Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit'>[],
  accountCode: string,
  normal: 'DEBIT' | 'CREDIT',
): { controlBalance: Centavos; subsidiaryTotal: Centavos; difference: Centavos; reconciled: boolean } {
  let cd = 0,
    cc = 0,
    sd = 0,
    sc = 0;
  for (const b of balances) {
    if (b.accountCode !== accountCode) continue;
    if (b.subsidiaryId === null) {
      cd += b.debit;
      cc += b.credit;
    } else {
      sd += b.debit;
      sc += b.credit;
    }
  }
  const controlBalance = normalSignedBalance(cd as Centavos, cc as Centavos, normal);
  const subsidiaryTotal = normalSignedBalance(sd as Centavos, sc as Centavos, normal);
  const difference = (controlBalance - subsidiaryTotal) as Centavos;
  return { controlBalance, subsidiaryTotal, difference, reconciled: difference === 0 };
}
