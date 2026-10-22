import { describe, expect, it } from 'vitest';
import {
  allocateCashFlows,
  buildChartOfAccounts,
  buildTrialBalance,
  computeEquityChanges,
  computeScf,
  computeSfp,
  computeSfperf,
  netByAccount,
  resolveFsLine,
  scfLineFor,
  tbMonths,
  type AccountBalanceDoc,
  type Centavos,
} from '../src';

const accounts = new Map(buildChartOfAccounts().map((a) => [a.accountCode, a]));
type B = Pick<AccountBalanceDoc, 'accountCode' | 'subsidiaryId' | 'debit' | 'credit' | 'month'>;

/** Post a balanced entry into a balance fixture (roll-up rows only). */
function post(bals: B[], month: number, lines: Array<[code: string, debit: number, credit: number]>) {
  const d = lines.reduce((t, l) => t + l[1], 0);
  const c = lines.reduce((t, l) => t + l[2], 0);
  if (d !== c) throw new Error('fixture entry does not balance');
  for (const [accountCode, debit, credit] of lines) bals.push({ accountCode, subsidiaryId: null, debit: debit as Centavos, credit: credit as Centavos, month });
}

/** Opening balances, a year of activity, depreciation (contra) and an accrual. */
function fixture(): B[] {
  const b: B[] = [];
  post(b, 0, [['1-01-01-010', 5000000, 0], ['1-01-02-010', 50000000, 0], ['1-07-05-020', 20000000, 0], ['1-07-05-021', 0, 4000000], ['2-01-01-010', 0, 3000000], ['3-01-01-010', 0, 68000000]]);
  post(b, 1, [['1-01-01-010', 12500000, 0], ['4-01-04-010', 0, 12000000], ['4-04-01-010', 0, 500000]]); // collections
  post(b, 1, [['1-01-02-010', 12500000, 0], ['1-01-01-010', 0, 12500000]]); // deposit
  post(b, 2, [['5-02-03-010', 2000000, 0], ['1-01-02-010', 0, 1800000], ['2-02-01-010', 0, 200000]]); // DV with tax withheld
  post(b, 3, [['5-01-02-050', 3000000, 0], ['1-01-02-010', 0, 3000000]]); // honoraria
  post(b, 3, [['1-07-05-030', 4000000, 0], ['1-01-02-010', 0, 4000000]]); // equipment
  post(b, 3, [['2-01-01-010', 3000000, 0], ['1-01-02-010', 0, 3000000]]); // pay AP
  post(b, 3, [['5-02-04-020', 350000, 0], ['2-01-01-010', 0, 350000]]); // accrual
  post(b, 3, [['5-04-01-040', 100000, 0], ['1-07-05-021', 0, 100000]]); // depreciation
  post(b, 4, [['3-01-01-020', 0, 50000], ['1-01-01-010', 50000, 0]]); // prior years' adjustment
  post(b, 5, [['5-02-10-030', 1000000, 0], ['1-01-02-010', 0, 1000000]]); // SK transfer
  return b;
}

describe('financial statement mapping', () => {
  it('maps seed accounts to catalog lines, contra within its asset line', () => {
    expect(resolveFsLine('1-01-02-010', accounts.get('1-01-02-010')).line.id).toBe('SFP.CA.CASH');
    expect(resolveFsLine('1-07-05-021', accounts.get('1-07-05-021')).line.id).toBe('SFP.NCA.PPE');
    expect(resolveFsLine('4-01-04-010', accounts.get('4-01-04-010')).line.id).toBe('SFPERF.REV.SHARE_IRA');
    expect(resolveFsLine('5-02-10-030', accounts.get('5-02-10-030')).line.id).toBe('SFPERF.TRANSFERS_TO');
    // Unknown classification falls back to the seed, then to a catch-all by type.
    expect(resolveFsLine('1-01-02-010', { financialStatementClassification: 'BOGUS' }).line.id).toBe('SFP.CA.CASH');
    expect(resolveFsLine('5-99-99-999', null)).toMatchObject({ mapped: false, line: { id: 'SFPERF.EXP.MOOE' } });
  });

  it('SFP balances before closing (surplus flows into net assets) with PPE shown net', () => {
    const sfp = computeSfp(netByAccount(fixture(), 0, 13), accounts);
    expect(sfp.balanced).toBe(true);
    expect(sfp.lines.get('SFP.NCA.PPE')!.amount).toBe(20000000 - 4100000 + 4000000);
    expect(sfp.lines.get('SFP.NCA.PPE')!.accounts.find((a) => a.accountCode === '1-07-05-021')).toMatchObject({ amount: -4100000, contra: true });
    expect(sfp.lines.get('SFP.CA.CASH')!.amount).toBe(5000000 + 50000000 + 50000 + 12500000 - 12500000 + 12500000 - 1800000 - 3000000 - 4000000 - 3000000 - 1000000);
    expect(sfp.totalLiabilities).toBe(200000 + 350000);
    expect(sfp.unclosedSurplus).toBe(12500000 - 2000000 - 3000000 - 350000 - 100000 - 1000000);
    expect(sfp.totalAssets).toBe(sfp.totalLiabilities + sfp.totalNetAssets);
  });

  it('SFPerf: revenue, current operating expenses, transfers → surplus', () => {
    const p = computeSfperf(netByAccount(fixture(), 1, 12), accounts);
    expect(p.totalRevenue).toBe(12500000);
    expect(p.totalExpenses).toBe(2000000 + 3000000 + 350000 + 100000);
    expect(p.lines.get('SFPERF.EXP.NON_CASH')!.amount).toBe(100000);
    expect(p.transfersTo).toBe(1000000);
    expect(p.surplus).toBe(12500000 - 5450000 - 1000000);
  });

  it('SFPerf surplus equals the change in net assets/equity (after prior years\' adjustments)', () => {
    const b = fixture();
    const open = computeSfp(netByAccount(b, 0, 0), accounts).totalNetAssets;
    const close = computeSfp(netByAccount(b, 0, 13), accounts).totalNetAssets;
    const ch = computeEquityChanges(b, accounts);
    expect(ch.beginningBalance).toBe(open);
    expect(ch.priorPeriodAdjustments).toBe(50000);
    expect(ch.surplusDeficit).toBe(computeSfperf(netByAccount(b, 1, 12), accounts).surplus);
    expect(close - open - ch.priorPeriodAdjustments).toBe(ch.surplusDeficit);
    expect(ch.endingBalance).toBe(close);
  });

  it('closing entries (period 13) move the surplus to equity without changing the totals', () => {
    const b = fixture();
    const nominal = [...netByAccount(b, 1, 12)].filter(([c]) => /^[45]/.test(c));
    const surplus = -nominal.reduce((t, [, n]) => t + n, 0);
    post(b, 13, [...nominal.map(([c, n]) => [c, n < 0 ? -n : 0, n > 0 ? n : 0] as [string, number, number]), ['3-01-01-010', surplus < 0 ? -surplus : 0, surplus > 0 ? surplus : 0]]);
    const sfp = computeSfp(netByAccount(b, 0, 13), accounts);
    expect(sfp.balanced).toBe(true);
    expect(sfp.unclosedSurplus).toBe(0);
    expect(computeEquityChanges(b, accounts).endingBalance).toBe(sfp.totalNetAssets);
    // Post-closing TB keeps only real accounts; pre-closing still balances.
    expect(buildTrialBalance(b, accounts, { throughMonth: 13, includeClosing: true }).rows.some((r) => /^[45]/.test(r.accountCode))).toBe(false);
    expect(buildTrialBalance(b, accounts, { ...tbMonths('PRE_CLOSING', 3) }).balanced).toBe(true);
  });

  it('TB variants map to period ranges', () => {
    expect(tbMonths('MONTHLY', 3)).toEqual({ throughMonth: 3, includeClosing: false });
    expect(tbMonths('PRE_CLOSING', 3)).toEqual({ throughMonth: 12, includeClosing: false });
    expect(tbMonths('POST_CLOSING', 3)).toEqual({ throughMonth: 13, includeClosing: true });
  });
});

describe('cash flows (direct method)', () => {
  const isCash = (c: string) => c.startsWith('1-01');

  it('skips transfers between cash accounts and nets tax withheld into the payment', () => {
    const f = allocateCashFlows(
      [
        { jevId: 'dep', accountCode: '1-01-02-010', debit: 100, credit: 0 },
        { jevId: 'dep', accountCode: '1-01-01-010', debit: 0, credit: 100 },
        { jevId: 'dv', accountCode: '5-02-03-010', debit: 1000, credit: 0 },
        { jevId: 'dv', accountCode: '1-01-02-010', debit: 0, credit: 900 },
        { jevId: 'dv', accountCode: '2-02-01-010', debit: 0, credit: 100 },
      ],
      isCash,
    );
    expect(f).toEqual([{ jevId: 'dv', accountCode: '5-02-03-010', amount: -900 }]);
  });

  it('allocates a split receipt exactly (largest remainder)', () => {
    const f = allocateCashFlows(
      [
        { jevId: 'r', accountCode: '1-01-01-010', debit: 100, credit: 0 },
        { jevId: 'r', accountCode: '4-01-01-010', debit: 0, credit: 50 },
        { jevId: 'r', accountCode: '4-04-01-010', debit: 0, credit: 50 },
        { jevId: 'x', accountCode: '1-01-02-010', debit: 0, credit: 10 },
        { jevId: 'x', accountCode: '5-02-03-010', debit: 7, credit: 0 },
        { jevId: 'x', accountCode: '5-02-03-020', debit: 7, credit: 0 },
        { jevId: 'x', accountCode: '2-02-01-010', debit: 0, credit: 4 },
      ],
      isCash,
    );
    expect(f.filter((x) => x.jevId === 'x').reduce((t, x) => t + x.amount, 0)).toBe(-10);
    expect(f.filter((x) => x.jevId === 'r').map((x) => x.amount)).toEqual([50, 50]);
  });

  it('classifies counter-accounts into SCF lines', () => {
    expect(scfLineFor('4-01-04-010', 1, accounts.get('4-01-04-010')).id).toBe('OP_IN_IRA');
    expect(scfLineFor('4-01-01-010', 1, accounts.get('4-01-01-010')).id).toBe('OP_IN_TAX');
    expect(scfLineFor('5-01-02-050', -1, accounts.get('5-01-02-050')).id).toBe('OP_OUT_PS');
    expect(scfLineFor('5-02-10-030', -1, accounts.get('5-02-10-030')).id).toBe('OP_OUT_TRANSFERS');
    expect(scfLineFor('1-07-05-030', -1, accounts.get('1-07-05-030')).id).toBe('INV_OUT_PPE');
    expect(scfLineFor('2-01-03-010', 1, accounts.get('2-01-03-010')).id).toBe('FIN_IN_LOANS');
  });

  it('SCF reconciles to the ending cash balances', () => {
    const b = fixture();
    // Journal lines equivalent to the fixture's months 1–12 entries; a new JEV starts whenever the running net is back to zero.
    const lines = b.filter((x) => x.month >= 1 && x.month <= 12);
    const grouped: Array<{ jevId: string; accountCode: string; debit: number; credit: number; month: number }> = [];
    let jev = 0;
    let open = 0;
    for (const l of lines) {
      if (open === 0) jev++;
      grouped.push({ jevId: `j${jev}`, accountCode: l.accountCode, debit: l.debit, credit: l.credit, month: l.month });
      open += l.debit - l.credit;
    }
    const scf = computeScf(grouped, b, accounts);
    expect(scf.reconciled).toBe(true);
    expect(scf.beginningCash).toBe(55000000);
    expect(scf.investing).toBe(-4000000);
    expect(scf.lines.get('OP_IN_IRA')!.amount).toBe(12000000);
    expect(scf.lines.get('OP_OUT_MOOE')!.amount).toBe(-1800000 - 3000000);
    expect(scf.endingCash).toBe(scf.cashAccountsEnding);
  });
});
