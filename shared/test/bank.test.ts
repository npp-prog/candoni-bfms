import { describe, expect, it } from 'vitest';
import {
  assertReconciliationBalanced,
  bookBalanceFromRows,
  bookItemsFromJournal,
  buildStatementLines,
  checkNoOf,
  defaultMemoAccount,
  isStaleCheck,
  lineCheckNo,
  normalizeRef,
  parseStatementDate,
  parseStatementPaste,
  reconcileBank,
  runBankRecon,
  storedReconInputs,
  suggestLineClass,
  type BankReconData,
  type BookLine,
  type Centavos,
  type ReconMemo,
  type StatementLineInput,
  reportBuilder,
  runReport,
  type DataSource,
  type Filter,
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
    expect(parseStatementDate('1/13/2025 23:59:59')).toBe('2025-01-13');
    expect(parseStatementDate('2025-01-14 12:04:22')).toBe('2025-01-14');
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

  it('reads the legacy 04.2 ChecksEncashed layout (with and without its header)', () => {
    const sheet = 'Ending Balance\t\t\t\t48,723.72\nMonth\tCheck No.\tDebit Amount\tCredit Amount\tBalance\n\tBalance\t\t795,276.40\t795,276.40\n1/2/2025 23:59:59\t1655543.0\t46,060.00\t\t749,216.40\n1/22/2025 11:44:04\t\t\t240,000.00\t989,216.40\n';
    const r = parseStatementPaste(sheet);
    expect(r.errors).toEqual([]);
    expect(r.legacyLayout).toBe(true);
    expect(r.beginningBalance).toBe(79527640);
    expect(r.endingBalance).toBe(4872372);
    expect(r.lines).toEqual([
      { date: '2025-01-02', reference: '1655543', description: 'Check encashed', checkNumber: '1655543', debit: 4606000, credit: 0 },
      { date: '2025-01-22', reference: '', description: 'Deposit / credit', checkNumber: null, debit: 0, credit: 24000000 },
    ]);
    const bare = parseStatementPaste('01/13/2025\t1655547\t2450\t\n01/31/2025\t\t\t359410\n');
    expect(bare.legacyLayout).toBe(true);
    expect(bare.lines.map((l) => [l.checkNumber, l.debit, l.credit])).toEqual([['1655547', 245000, 0], [null, 0, 35941000]]);
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
  });

  it('recognises check numbers but not memo / OR references', () => {
    expect(normalizeRef('CHK 0001762250')).toBe('1762250');
    expect(normalizeRef('1655543.0')).toBe('1655543');
    expect(checkNoOf('1762250')).toBe('1762250');
    expect(checkNoOf('Check No. 0001762250')).toBe('1762250');
    expect(checkNoOf('BM-2026-03-001')).toBe('');
    expect(checkNoOf('ADA-2026-001')).toBe('');
    expect(lineCheckNo({ debit: c(1), reference: '', description: 'CHECK 1762250 PAID', checkNumber: null })).toBe('1762250');
    expect(lineCheckNo({ debit: c(0), reference: '1762250', description: '', checkNumber: null })).toBe('');
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

// ------------------------------------------------------------------ journal-based reconciliation

let seq = 0;
function jl(date: string, debit: number, credit: number, ref: string | null = null, extra: Partial<BookLine> = {}): BookLine {
  seq++;
  return { jevId: `J${seq}`, lineNo: 1, jevNumber: `${date.slice(0, 7)}-${String(seq).padStart(3, '0')}`, jevDate: date, accountingPeriod: date.slice(0, 7), entryType: 'REGULAR', debit: c(debit), credit: c(credit), primaryReference: ref, secondaryReference: ref ? `DV-${ref}` : 'RCD-1', payeeName: ref ? `Payee ${ref}` : null, lineDescription: '', ...extra };
}
const stmt = (begin: number, lines: Array<Partial<StatementLineInput> & { date: string }>) =>
  buildStatementLines(c(begin), lines.map((l) => ({ reference: '', description: '', debit: c(0), credit: c(0), ...l })));

/** A March month: opening book 100,000 (period 00); prior-year check 900 outstanding; Jan 1 bank 100,900. */
function march() {
  seq = 0;
  const lines: BookLine[] = [
    jl('2026-03-05', 0, 1500000, '1001'),
    jl('2026-03-25', 0, 800000, '1002'),
    jl('2026-03-10', 2000000, 0),
    jl('2026-03-31', 500000, 0),
  ];
  const opening = { outstandingChecks: [{ id: 'p1', date: '2025-12-20', checkNumber: '0900', payeeName: 'Old payee', dvNumber: 'DV-2025-12-01', amount: c(90000) }], depositsInTransit: [] };
  const book = bookItemsFromJournal({ fiscalYear: 2026, month: 3, asOf: '2026-03-31', lines, opening, cancelled: [{ id: 'x1', barangayId: 'AGBOY', bankAccountId: 'B', checkNumber: '1003', checkDate: '2026-03-26', payeeName: 'Spoiled', remarks: 'Spoiled' }] }).items;
  const s = stmt(10090000, [
    { date: '2026-03-02', reference: '900', debit: c(90000) },
    { date: '2026-03-06', checkNumber: '1001', reference: '1001', description: 'CHECK', debit: c(1500000) },
    { date: '2026-03-11', description: 'DEPOSIT', credit: c(2000000) },
    { date: '2026-03-31', description: 'SERVICE CHARGE', debit: c(5000) },
    { date: '2026-03-31', description: 'INTEREST EARNED', credit: c(1234) },
  ]);
  // Book: 100,000 − 15,000 − 8,000 + 20,000 + 5,000 = 102,000.
  return { lines, opening, book, s, base: { fiscalYear: 2026, month: 3, bookBalance: c(10200000), bankBalance: s.computedEndingBalance, book, bankLines: s.lines, memos: [] as ReconMemo[], classifications: {}, manualItems: [], manualMatches: [] } };
}

describe('bookItemsFromJournal', () => {
  it('splits credits with a check no., other credits and debits; nets a reversal; lists cancelled checks at 0', () => {
    seq = 0;
    const a = jl('2026-02-03', 0, 100000, '2001');
    const rev = jl('2026-02-10', 100000, 0, '2001', { entryType: 'REVERSING' });
    const b = jl('2026-02-04', 0, 50000, '2002');
    const takeBack = jl('2026-02-20', 50000, 0, '2002', { entryType: 'CORRECTING' });
    const memo = jl('2026-02-28', 0, 5000, 'BM-2026-02-001');
    const opening = jl('2026-01-01', 900000, 0, null, { accountingPeriod: '2026-00', entryType: 'OPENING' });
    const r = bookItemsFromJournal({ fiscalYear: 2026, month: 2, asOf: '2026-02-28', lines: [a, rev, b, takeBack, memo, opening], reversed: [{ jevId: a.jevId, reversedByJevId: rev.jevId }], cancelled: [{ id: 'k', barangayId: 'AGBOY', bankAccountId: 'B', checkNumber: '2003', checkDate: '2026-02-05', payeeName: null, remarks: 'Cancelled' }] });
    const byKey = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(r.items.map((i) => `${i.kind}:${i.checkNumber || i.reference}:${i.amount}:${i.cancelled ? 'X' : ''}`).sort()).toEqual(
      ['CHECK:2001:0:X', 'CHECK:2002:0:X', 'CHECK:2003:0:X', 'DISBURSEMENT:DV-BM-2026-02-001:5000:'].sort(),
    );
    expect(byKey['CHK:2002']!.cancelRemarks).toMatch(/Taken back up/);
  });
});

describe('reconcileBank (journal-based)', () => {
  it('matches checks by number and deposits by amount/date; schedules and BRS figures', () => {
    const { base } = march();
    const r = reconcileBank(base);
    expect(r.matches.map((m) => `${m.bookKey}:${m.how}`).sort()).toEqual(['CHK:1001:CHECK_NO', 'JL:J3:1:AMOUNT_DATE', 'PY:p1:CHECK_NO']);
    expect(r.totals.outstandingChecks).toBe(800000);
    expect(r.totals.depositInTransit).toBe(500000);
    expect(r.totals.bankCharges).toBe(5000);
    expect(r.totals.interestIncome).toBe(1234);
    // Bank 100,900 − 900 − 15,000 + 20,000 − 50 + 12.34 = 104,962.34; + 5,000 − 8,000 = 101,962.34.
    expect(r.bankBalance).toBe(10496234);
    expect(r.adjustedBankBalance).toBe(10196234);
    expect(r.adjustedBookBalance).toBe(10196234);
    expect(r.difference).toBe(0);
    // Schedule 1: prior year cleared; 1001 cleared; 1002 outstanding; 1003 cancelled at 0.
    expect(r.schedule1.map((s) => `${s.priorYear ? 'PY' : 'CY'}:${s.checkNumber}:${s.book}:${s.bank}:${s.diff}:${s.status}`)).toEqual([
      'PY:0900:90000:90000:0:CLEARED',
      'CY:1001:1500000:1500000:0:CLEARED',
      'CY:1002:800000:0:800000:OUTSTANDING',
      'CY:1003:0:0:0:CANCELLED',
    ]);
    expect(r.schedule2.map((s) => `${s.book}:${s.bank}:${s.diff}:${s.remarks}`)).toEqual(['2000000:2000000:0:', '500000:0:500000:Deposit in transit']);
    expect(r.adjustments.map((s) => `${s.bank}:${s.remarks}`)).toEqual(['-5000:Bank charges', '1234:Interest earned']);
    expect(r.items.every((i, k) => i.seq === k + 1)).toBe(true);
  });

  it('flags a check encashed for a different amount as a book error', () => {
    const m = march();
    const s = stmt(10090000, [{ date: '2026-03-02', reference: '900', debit: c(90000) }, { date: '2026-03-06', reference: '1001', debit: c(1050000) }]);
    const r = reconcileBank({ ...m.base, bankLines: s.lines, bankBalance: s.computedEndingBalance });
    const row = r.schedule1.find((x) => x.checkNumber === '1001')!;
    expect(row.status).toBe('AMOUNT_DIFFERS');
    expect(row.diff).toBe(450000);
    expect(r.totals.bookErrors).toBe(450000);
  });

  it('is cumulative: a check issued in March and cleared in April leaves the outstanding list', () => {
    const m = march();
    const apr = stmt(10496234, [{ date: '2026-04-03', reference: '1002', debit: c(800000) }, { date: '2026-04-02', description: 'DEP', credit: c(500000) }]);
    const book = bookItemsFromJournal({ fiscalYear: 2026, month: 4, asOf: '2026-04-30', lines: m.lines, opening: m.opening }).items;
    const r = reconcileBank({ ...m.base, month: 4, book, bankLines: [...m.s.lines, ...apr.lines], bankBalance: apr.computedEndingBalance, classifications: {} });
    expect(r.totals.outstandingChecks).toBe(0);
    expect(r.totals.depositInTransit).toBe(0);
    // March's charge and interest are still not in the books.
    expect(r.totals.bankCharges).toBe(5000);
    expect(r.difference).toBe(0);
  });

  it('posted memo JEVs match their statement line; unposted memos stay reconciling; classifications apply', () => {
    const m = march();
    const charge = m.s.lines.find((l) => l.description === 'SERVICE CHARGE')!;
    const interest = m.s.lines.find((l) => l.description === 'INTEREST EARNED')!;
    const memoLine = jl('2026-03-31', 0, 5000, 'BM-2026-03-001');
    const book = bookItemsFromJournal({ fiscalYear: 2026, month: 3, asOf: '2026-03-31', lines: [...m.lines, memoLine], opening: m.opening }).items;
    const memo = (id: string, type: 'DEBIT' | 'CREDIT', amount: number, lineId: string, posted: boolean, jevId: string | null): ReconMemo => ({ id, memoType: type, category: type === 'DEBIT' ? 'BANK_CHARGES' : 'INTEREST_INCOME', memoDate: '2026-03-31', amount: c(amount), memoNumber: `BM-${id}`, bankReference: '', particulars: 'x', statementLineId: lineId, posted, jevId, status: 'ACCEPTED' });
    const r = reconcileBank({ ...m.base, book, bookBalance: c(10200000 - 5000), memos: [memo('1', 'DEBIT', 5000, charge.lineId, true, memoLine.jevId), memo('2', 'CREDIT', 1234, interest.lineId, false, 'jx')] });
    expect(r.matches.find((x) => x.lineId === charge.lineId)?.how).toBe('MEMO');
    expect(r.totals.bankCharges).toBe(0);
    expect(r.items.find((i) => i.category === 'INTEREST_INCOME')?.sourceId).toBe('2');
    expect(r.difference).toBe(0);
    const r2 = reconcileBank({ ...m.base, classifications: { [interest.lineId]: 'BANK_ERROR', [charge.lineId]: 'BANK_CREDIT_MEMO' } });
    expect(r2.totals.bankErrors).toBe(-1234);
    expect(r2.totals.bankCharges).toBe(5000); // invalid class for a debit line falls back to the suggestion
    expect(r2.lineClasses[charge.lineId]?.suggested).toBe(true);
  });

  it('manual matches and items; finalize guard', () => {
    const m = march();
    // A ₱2,000 deposit journalised twice → unexplained until a book error is entered.
    const dup = jl('2026-03-12', 200000, 0);
    const book = bookItemsFromJournal({ fiscalYear: 2026, month: 3, asOf: '2026-03-31', lines: [...m.lines, dup], opening: m.opening }).items;
    const r = reconcileBank({ ...m.base, book, bookBalance: c(10400000) });
    expect(r.difference).toBe(0); // it shows as a deposit in transit…
    expect(r.totals.depositInTransit).toBe(700000);
    const lineId = m.s.lines.find((l) => l.description === 'SERVICE CHARGE')!.lineId;
    const r2 = reconcileBank({ ...m.base, manualMatches: [{ lineId, bookKey: 'CHK:1002' }, { lineId: 'nope', bookKey: 'CHK:1002' }] });
    expect(r2.matches.find((x) => x.how === 'MANUAL')?.bookKey).toBe('CHK:1002');
    expect(r2.rejectedMatches[0]?.reason).toMatch(/not found/);
    const r3 = reconcileBank({ ...m.base, manualItems: [{ id: 'm1', category: 'BOOK_ERROR', date: '2026-03-15', reference: '', name: 'x', amount: c(-100), remarks: '' }] });
    expect(r3.difference).toBe(-100);
    expect(() => assertReconciliationBalanced(r3.difference)).toThrow();
  });

  it('reproduces the legacy Agboy Dec 2025 BRS (book 3,638.99, bank 48,723.72, OC 45,084.73)', () => {
    seq = 0;
    // Prior-year outstanding 44,574.73 (never encashed) and a current-year check of 510.00 outstanding.
    const opening = { outstandingChecks: [{ id: 'a', date: '2019-05-17', checkNumber: '1346110', payeeName: '', dvNumber: '', amount: c(4457473) }], depositsInTransit: [] };
    const lines = [jl('2025-12-15', 0, 51000, '1762249')];
    const book = bookItemsFromJournal({ fiscalYear: 2025, month: 12, asOf: '2025-12-31', lines, opening }).items;
    const s = stmt(4872372, []);
    const r = reconcileBank({ fiscalYear: 2025, month: 12, bookBalance: c(363899), bankBalance: s.computedEndingBalance, book, bankLines: s.lines, memos: [], classifications: {}, manualItems: [], manualMatches: [] });
    expect(r.totals.outstandingChecks).toBe(4508473);
    expect(r.adjustedBankBalance).toBe(363899);
    expect(r.adjustedBookBalance).toBe(363899);
    expect(r.schedule1.find((x) => x.priorYear)?.status).toBe('STALE');
  });

  it('runBankRecon: inherits earlier months’ classifications and warns about gaps', () => {
    const m = march();
    const interest = m.s.lines.find((l) => l.description === 'INTEREST EARNED')!;
    const d = {
      period: { barangayId: 'AGBOY', bankAccountId: 'B', fiscalYear: 2026, month: 3 },
      id: 'x', monthStart: '2026-03-01', monthEnd: '2026-03-31',
      bank: { id: 'B' },
      statement: { month: 3, lines: m.s.lines, endingBalance: m.s.computedEndingBalance, beginningBalance: c(10090000), balanced: true, statementPeriod: '2026-03' },
      statements: [{ month: 3, lines: m.s.lines, endingBalance: m.s.computedEndingBalance, beginningBalance: c(10090000), balanced: true, statementPeriod: '2026-03' }],
      opening: { ...m.opening, totalOutstandingChecks: c(90000), totalDepositsInTransit: c(0) },
      recon: null,
      priorRecons: [{ month: 2, classifications: { [interest.lineId]: 'CLEARED_PRIOR' }, manualMatches: [] }],
      bookLines: m.lines, reversed: [], cancelled: [], memos: [], bookBalance: c(10200000), openingBookBalance: c(10000000),
    } as unknown as BankReconData;
    expect(storedReconInputs(d).classifications[interest.lineId]).toBe('CLEARED_PRIOR');
    const r = runBankRecon(d);
    expect(r.totals.interestIncome).toBe(0);
    expect(r.difference).toBe(-1234);
    expect(r.warnings.some((w) => /No bank statement for 2026-01/.test(w))).toBe(true);
  });

  it('stale and book-balance helpers', () => {
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

// ------------------------------------------------------------------ reports from journal data only

function memoryDs(data: Record<string, Array<Record<string, unknown>>>): DataSource {
  const match = (r: Record<string, unknown>, f: readonly Filter[]) => f.every(([k, op, v]) => (op === 'in' ? (v as unknown[]).includes(r[k]) : r[k] === v));
  return {
    async get(col, id) { return ((data[col] ?? []).find((r) => r.id === id) ?? null) as never; },
    async list(col, f) { return (data[col] ?? []).filter((r) => match(r, f)) as never; },
    async listGroup(col, f) { return (data[col] ?? []).filter((r) => match(r, f)) as never; },
    async listSub() { return []; },
  };
}

describe('bank reports (journal only — no checks / deposits documents)', () => {
  const SL = 'AGBOY_1-01-02-010_CIB02';
  const line = (jevId: string, date: string, debit: number, credit: number, ref: string | null, payee: string | null = null) => ({
    id: '001', barangayId: 'AGBOY', fiscalYear: 2026, accountingPeriod: date.slice(0, 7), fundId: 'GF', jevId, jevDate: date, jevNumber: `${date.slice(0, 7)}-${jevId}`, journal: 'JCT', entryType: 'REGULAR', posted: true, lineNo: 1,
    accountCode: '1-01-02-010', subsidiaryId: SL, debit, credit, lineDescription: '', primaryReference: ref, secondaryReference: ref ? `DV-${ref}` : 'RCD-01', payeeName: payee, fppId: null, officeId: null,
  });
  const s = buildStatementLines(c(10090000), [
    { date: '2026-03-02', reference: '', checkNumber: '900', description: 'CHECK', debit: c(90000), credit: c(0) },
    { date: '2026-03-06', reference: '', checkNumber: '1001', description: 'CHECK', debit: c(1500000), credit: c(0) },
    { date: '2026-03-11', reference: '', description: 'DEPOSIT', debit: c(0), credit: c(2000000) },
  ]);
  const ds = memoryDs({
    bankAccounts: [{ id: 'B2', barangayId: 'AGBOY', bankName: 'DBP', branch: 'Kabankalan', accountName: 'AGBOY BRGY', accountNumber: '0098765432', fundId: 'GF', subsidiaryId: SL, active: true }],
    signatories: [],
    lines: [line('J1', '2026-03-05', 0, 1500000, '1001', 'Supplier A'), line('J2', '2026-03-25', 0, 800000, '1002', 'Supplier B'), line('J3', '2026-03-10', 2000000, 0, null)],
    journalEntries: [{ id: 'J1', barangayId: 'AGBOY', fiscalYear: 2026, status: 'POSTED', particulars: 'Office supplies' }],
    cancelledChecks: [{ id: 'X', barangayId: 'AGBOY', bankAccountId: 'B2', checkNumber: '1003', checkDate: '2026-03-26', payeeName: null, remarks: 'Spoiled' }],
    bankStatements: [
      { id: 'AGBOY_B2_2026_00', kind: 'OPENING', barangayId: 'AGBOY', fiscalYear: 2026, month: 0, bankAccountId: 'B2', outstandingChecks: [{ id: 'p', date: '2025-12-20', checkNumber: '900', payeeName: 'Old', dvNumber: '', amount: 90000 }], depositsInTransit: [], totalOutstandingChecks: 90000, totalDepositsInTransit: 0 },
      { id: 'AGBOY_B2_2026_03', barangayId: 'AGBOY', fiscalYear: 2026, month: 3, bankAccountId: 'B2', statementPeriod: '2026-03', statementDate: '2026-03-31', beginningBalance: 10090000, endingBalance: s.computedEndingBalance, lines: s.lines, balanced: true },
    ],
    accountBalances: [
      { barangayId: 'AGBOY', fiscalYear: 2026, month: 0, accountCode: '1-01-02-010', subsidiaryId: SL, debit: 10000000, credit: 0 },
      { barangayId: 'AGBOY', fiscalYear: 2026, month: 3, accountCode: '1-01-02-010', subsidiaryId: SL, debit: 2000000, credit: 2300000 },
    ],
  });
  const P = { barangayId: 'AGBOY' as const, fiscalYear: 2026, month: 3, bankAccountId: 'B2' };
  type Rows = { rows: Array<{ cells: Record<string, unknown> }> };

  it('CHECKS_ISSUED lists the journal checks and the cancelled one at zero', async () => {
    const m = await runReport(reportBuilder('CHECKS_ISSUED')!, ds, P);
    const t = m.sections[0] as Rows;
    expect(t.rows.map((r) => [r.cells.checkNo, r.cells.amount])).toEqual([['1001', 1500000], ['1002', 800000], ['1003', 0], [undefined, 2300000]]);
    expect(t.rows[0]!.cells.nature).toBe('Office supplies');
    expect(m.isEmpty).toBe(false);
  });

  it('BRS preview, schedules, outstanding and encashed checks', async () => {
    const brs = await runReport(reportBuilder('BRS')!, ds, P);
    const rows = (brs.sections[0] as Rows).rows;
    expect(rows.find((r) => r.cells.label === 'ADJUSTED BOOK BALANCE')?.cells.amount).toBe(9700000);
    expect(rows.find((r) => r.cells.label === 'ADJUSTED BANK BALANCE')?.cells.amount).toBe(9700000);
    expect(rows.find((r) => r.cells.label === 'Proof')?.cells.amount).toBe(0);
    const sch = await runReport(reportBuilder('BRS_SCHEDULES')!, ds, P);
    expect((sch.sections[0] as Rows).rows.at(-1)?.cells).toMatchObject({ ref: 'Grand Total', book: 2390000, bank: 1590000, diff: 800000 });
    const oc = await runReport(reportBuilder('OUTSTANDING_CHECKS')!, ds, { ...P, month: undefined, asOf: '2026-03-31' });
    expect((oc.sections[0] as Rows).rows.length).toBe(2); // check 1002 + total
    const cl = await runReport(reportBuilder('CHECKS_CLEARED')!, ds, P);
    expect((cl.sections[0] as Rows).rows.map((r) => r.cells.check)).toEqual(['900', '1001', undefined]);
  });
});
