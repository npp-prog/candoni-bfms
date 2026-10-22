import { describe, expect, it } from 'vitest';
import {
  assertReconciliationBalanced,
  bookBalanceFromRows,
  buildReconciliation,
  buildStatementLines,
  defaultMemoAccount,
  isOutstandingAt,
  isStaleCheck,
  normalizeRef,
  parseStatementDate,
  parseStatementPaste,
  suggestLineClass,
  type Centavos,
  type ReconCheck,
  type ReconDeposit,
  type ReconInput,
  type ReconMemo,
} from '../src';

const c = (n: number) => n as Centavos;

describe('statement parsing', () => {
  it('parses the date formats banks export', () => {
    expect(parseStatementDate('2026-03-05')).toBe('2026-03-05');
    expect(parseStatementDate('03/05/2026')).toBe('2026-03-05');
    expect(parseStatementDate('3/5/26')).toBe('2026-03-05');
    expect(parseStatementDate('05-Mar-2026')).toBe('2026-03-05');
    expect(parseStatementDate('Mar 5, 2026')).toBe('2026-03-05');
    expect(parseStatementDate('03/05', 2026)).toBe('2026-03-05');
    expect(parseStatementDate('02/30/2026')).toBeNull();
    expect(parseStatementDate('Balance')).toBeNull();
  });

  it('parses a TSV paste with a header row and reordered columns', () => {
    const text = 'Date\tParticulars\tCheck No.\tWithdrawals\tDeposits\tBalance\n03/05/2026\tCHECK PAID\t0001762250\t1,500.00\t\t48,500.00\n03/09/2026\tDEPOSIT\t\t\t2,000.00\t50,500.00\n';
    const r = parseStatementPaste(text);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      { date: '2026-03-05', reference: '0001762250', description: 'CHECK PAID', debit: 150000, credit: 0 },
      { date: '2026-03-09', reference: '', description: 'DEPOSIT', debit: 0, credit: 200000 },
    ]);
  });

  it('parses quoted CSV positionally and reports bad rows', () => {
    const r = parseStatementPaste('2026-03-31,,"SVC CHG, MAR",50.00,\n2026-03-31,,both,1,1\nxx/yy,,bad,1,\n');
    expect(r.lines).toEqual([{ date: '2026-03-31', reference: '', description: 'SVC CHG, MAR', debit: 5000, credit: 0 }]);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3]);
  });

  it('assigns stable ids and running balances', () => {
    const lines = [
      { date: '2026-03-05', reference: '1762250', description: 'chk', debit: c(150000), credit: c(0) },
      { date: '2026-03-05', reference: '1762250', description: 'chk dup', debit: c(150000), credit: c(0) },
      { date: '2026-03-09', reference: '', description: 'dep', debit: c(0), credit: c(200000) },
    ];
    const a = buildStatementLines(c(5000000), lines);
    const b = buildStatementLines(c(5000000), lines);
    expect(a.lines.map((l) => l.lineId)).toEqual(b.lines.map((l) => l.lineId));
    expect(new Set(a.lines.map((l) => l.lineId)).size).toBe(3);
    expect(a.lines.map((l) => l.balance)).toEqual([4850000, 4700000, 4900000]);
    expect(a.computedEndingBalance).toBe(4900000);
    expect(a.totalDebits).toBe(300000);
    expect(normalizeRef('CHK 0001762250')).toBe('1762250');
  });

  it('suggests classifications from the description', () => {
    expect(suggestLineClass({ debit: c(5000), description: 'SVC CHG', reference: '' })).toBe('BANK_CHARGES');
    expect(suggestLineClass({ debit: c(5000), description: 'DM - RETURNED CHECK', reference: '' })).toBe('BANK_DEBIT_MEMO');
    expect(suggestLineClass({ debit: c(0), description: 'INTEREST EARNED', reference: '' })).toBe('INTEREST_INCOME');
    expect(suggestLineClass({ debit: c(0), description: 'CM - TRANSFER', reference: '' })).toBe('BANK_CREDIT_MEMO');
    expect(defaultMemoAccount('DEBIT', 'BANK_CHARGES')).toBe('5-03-01-020');
    expect(defaultMemoAccount('DEBIT', 'OTHER')).toBeNull();
  });
});

const chk = (id: string, no: string, date: string, amount: number, extra: Partial<ReconCheck> = {}): ReconCheck => ({ id, checkNumber: no, checkDate: date, amount: c(amount), payeeName: `Payee ${id}`, dvId: null, status: 'RELEASED', clearedDate: null, ...extra });
const dep = (id: string, date: string, amount: number, extra: Partial<ReconDeposit> = {}): ReconDeposit => ({ id, depositDate: date, amount: c(amount), reference: id, status: 'ACCEPTED', bankReconciledDate: null, ...extra });

function base(over: Partial<ReconInput> = {}): ReconInput {
  // Book: 50,000 opening − checks 1,500 + 800 + deposits 2,000 + 1,000 = 50,700.
  const stmt = buildStatementLines(c(5000000), [
    { date: '2026-03-06', reference: '0001762250', description: 'CHECK', debit: c(150000), credit: c(0) },
    { date: '2026-03-10', reference: '', description: 'DEPOSIT', debit: c(0), credit: c(200000) },
    { date: '2026-03-31', reference: '', description: 'SERVICE CHARGE', debit: c(5000), credit: c(0) },
    { date: '2026-03-31', reference: '', description: 'INTEREST EARNED', debit: c(0), credit: c(1234) },
  ]);
  return {
    monthStart: '2026-03-01',
    monthEnd: '2026-03-31',
    bookBalance: c(5070000),
    bankBalance: stmt.computedEndingBalance,
    lines: stmt.lines,
    checks: [chk('k1', '1762250', '2026-03-02', 150000), chk('k2', '1762251', '2026-03-20', 80000), chk('old', '1700000', '2026-01-10', 99999, { status: 'CLEARED', clearedDate: '2026-02-03' }), chk('void', '1762252', '2026-03-21', 1000, { status: 'VOID' })],
    deposits: [dep('d1', '2026-03-09', 200000), dep('d2', '2026-03-31', 100000), dep('dv', '2026-03-15', 5555, { status: 'VOID' })],
    adas: [],
    memos: [],
    classifications: {},
    manualItems: [],
    manualMatches: [],
    ...over,
  };
}

describe('buildReconciliation', () => {
  it('matches checks by number and deposits by amount/date; leaves the rest as reconciling items', () => {
    const r = buildReconciliation(base());
    expect(r.matches.map((m) => `${m.sourceCollection}:${m.sourceId}:${m.how}`).sort()).toEqual(['checks:k1:CHECK_NO', 'deposits:d1:AMOUNT_DATE']);
    expect(r.totals.outstandingChecks).toBe(80000);
    expect(r.totals.depositInTransit).toBe(100000);
    expect(r.totals.bankCharges).toBe(5000);
    expect(r.totals.interestIncome).toBe(1234);
    // Bank 5,046,234 + 100,000 − 80,000 = 5,066,234; book 5,070,000 + 1,234 − 5,000 = 5,066,234.
    expect(r.adjustedBankBalance).toBe(5066234);
    expect(r.adjustedBookBalance).toBe(5066234);
    expect(r.difference).toBe(0);
    expect(r.items.every((i, k) => i.seq === k + 1)).toBe(true);
    expect(r.items.filter((i) => i.suggested).length).toBe(2);
  });

  it('balances once a manual book error is entered, and rejects bad manual matches', () => {
    // The ₱2,000 deposit was journalised twice: book 52,700 → unexplained difference until corrected.
    expect(buildReconciliation(base({ bookBalance: c(5270000) })).difference).toBe(200000);
    const r = buildReconciliation(base({ bookBalance: c(5270000), manualItems: [{ id: 'm1', category: 'BOOK_ERROR', date: '2026-03-15', reference: 'JEV 2026-03-004', name: 'Deposit recorded twice', amount: c(-200000), remarks: '' }], manualMatches: [{ lineId: 'nope', sourceCollection: 'checks', sourceId: 'k2' }] }));
    expect(r.difference).toBe(0);
    expect(() => assertReconciliationBalanced(r.difference)).not.toThrow();
    expect(r.rejectedMatches[0]?.reason).toMatch(/not found/);
  });

  it('respects classifications and treats posted memos as recorded', () => {
    const b = base();
    const charge = b.lines.find((l) => l.description === 'SERVICE CHARGE')!;
    const interest = b.lines.find((l) => l.description === 'INTEREST EARNED')!;
    const memo = (id: string, type: 'DEBIT' | 'CREDIT', amount: number, lineId: string, posted: boolean): ReconMemo => ({ id, memoType: type, category: type === 'DEBIT' ? 'BANK_CHARGES' : 'INTEREST_INCOME', memoDate: '2026-03-31', amount: c(amount), memoNumber: `BM-2026-03-00${id}`, bankReference: '', particulars: 'x', statementLineId: lineId, posted, jevId: 'j', status: 'ACCEPTED' });
    // Unposted memo → still a book reconciling item; posted → no item.
    const r1 = buildReconciliation({ ...b, memos: [memo('1', 'DEBIT', 5000, charge.lineId, false), memo('2', 'CREDIT', 1234, interest.lineId, true)], bookBalance: c(5070000 + 1234) });
    expect(r1.difference).toBe(0);
    expect(r1.totals.bankCharges).toBe(5000);
    expect(r1.totals.interestIncome).toBe(0);
    expect(r1.items.find((i) => i.category === 'BANK_CHARGES')?.sourceId).toBe('1');
    // Classifying the interest line as a bank error moves it to the bank side, signed.
    const r2 = buildReconciliation({ ...b, classifications: { [interest.lineId]: 'BANK_ERROR', [charge.lineId]: 'BANK_CREDIT_MEMO' } });
    expect(r2.totals.bankErrors).toBe(-1234);
    expect(r2.totals.bankCharges).toBe(5000); // invalid class for a debit line falls back to the suggestion
    expect(r2.lineClasses[charge.lineId]?.suggested).toBe(true);
  });

  it('reproduces the legacy two-sided layout total (book 3,638.99 = adjusted bank)', () => {
    // Agboy-style month: one outstanding check, one deposit in transit, a ₱100 charge, ₱2.15 interest.
    const stmt = buildStatementLines(c(510000), [
      { date: '2025-12-31', reference: '', description: 'SERVICE CHARGE', debit: c(10000), credit: c(0) },
      { date: '2025-12-31', reference: '', description: 'INTEREST', debit: c(0), credit: c(215) },
    ]);
    const r = buildReconciliation({
      monthStart: '2025-12-01', monthEnd: '2025-12-31', bookBalance: c(373684), bankBalance: stmt.computedEndingBalance, lines: stmt.lines,
      checks: [chk('k', '1762239', '2025-12-02', 250000)], deposits: [dep('d', '2025-12-29', 113684)], adas: [], memos: [], classifications: {}, manualItems: [], manualMatches: [],
    });
    expect(r.adjustedBankBalance).toBe(363899);
    expect(r.adjustedBookBalance).toBe(363899);
    expect(r.balanced).toBe(true);
  });

  it('outstanding/stale helpers and book balance', () => {
    expect(isOutstandingAt({ status: 'CLEARED', clearedDate: '2026-04-02' }, '2026-03-10', '2026-03-31')).toBe(true);
    expect(isOutstandingAt({ status: 'CLEARED', clearedDate: '2026-03-12' }, '2026-03-10', '2026-03-31')).toBe(false);
    expect(isOutstandingAt({ status: 'PREPARED', clearedDate: null }, '2026-03-10', '2026-03-31')).toBe(false);
    expect(isStaleCheck('2025-08-31', '2026-02-28')).toBe(false);
    expect(isStaleCheck('2025-08-31', '2026-03-01')).toBe(true);
    const rows = [
      { accountCode: '1-01-02-010', subsidiaryId: 'SL', month: 0, debit: 100, credit: 0 },
      { accountCode: '1-01-02-010', subsidiaryId: 'SL', month: 3, debit: 50, credit: 20 },
      { accountCode: '1-01-02-010', subsidiaryId: null, month: 3, debit: 50, credit: 20 },
      { accountCode: '1-01-02-010', subsidiaryId: 'SL', month: 4, debit: 999, credit: 0 },
    ];
    expect(bookBalanceFromRows(rows, '1-01-02-010', 'SL', 3)).toBe(130);
  });
});
