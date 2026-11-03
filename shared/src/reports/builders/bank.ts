import { daysFrom, lineCheckNo, RECON_CATEGORY_LABELS, type ReconItemRecord, type Schedule1Row, type Schedule2Row } from '../../accounting/bankMatching';
import { computeBankReconciliation, totalReconItems } from '../../accounting/bankRecon';
import { lastDayOfMonth } from '../../accounting/periods';
import { bankBookItems, loadBankReconData, runBankRecon, type BankMemoRecord, type BankReconData, type BankReconRun } from '../../modules/bank';
import type { JournalEntryDoc } from '../../types/accounting';
import type { BankAccountDoc, ReconItemCategory } from '../../types/bank';
import type { Centavos, IsoDate } from '../../types/common';
import type { ExtraParam, ReportBody, ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { inRange, peso } from '../helpers';
import { col, longDate, row, table, validation, type ReportRow, type ReportSection } from '../model';

/**
 * Bank reports from the JOURNAL (legacy workbook sheets 04 BR, 04.1–04.4): the book side is the
 * posted lines on Cash in Bank and the account's CIB ledger, the bank side the statements.
 * Nothing here reads checks / deposits / ADA documents.
 */

const BANK_EXTRA: ExtraParam = { key: 'bankAccountId', label: 'Bank account', kind: 'bankAccount', required: true };

async function banksOf(ctx: ReportContext): Promise<WithId<BankAccountDoc>[]> {
  const banks = await ctx.ds.list<BankAccountDoc>('bankAccounts', [['barangayId', '==', ctx.params.barangayId]]);
  return banks.sort((a, b) => Number(b.active) - Number(a.active) || a.subsidiaryId.localeCompare(b.subsidiaryId));
}

/** The bank account asked for, else the barangay's first active account (monthly package runs). */
async function bankOf(ctx: ReportContext): Promise<WithId<BankAccountDoc> | null> {
  const banks = await banksOf(ctx);
  if (ctx.params.bankAccountId) return banks.find((b) => b.id === ctx.params.bankAccountId) ?? null;
  return banks.find((b) => b.active) ?? null;
}

const mask = (n: string) => (n.length <= 4 ? n : `${'•'.repeat(Math.min(6, n.length - 4))}${n.slice(-4)}`);
const bankLabel = (b: BankAccountDoc) => `${b.bankName}${b.branch ? ` (${b.branch})` : ''} — ${b.accountName} — Acct. No. ${mask(b.accountNumber)}`;

function bankMeta(ctx: ReportContext, b: BankAccountDoc | null) {
  if (!b) return [{ label: 'Bank account', value: '(none selected)' }];
  const bt = ctx.sign('Disbursing Officer', 'BARANGAY_TREASURER');
  return [
    { label: 'Name of bank account', value: b.accountName },
    { label: 'Bank account no.', value: b.accountNumber },
    { label: 'Authorized depository', value: b.bankName },
    { label: 'Address of depository', value: b.branch },
    { label: 'Disbursing officer', value: bt.name },
  ];
}

function noBank(ctx: ReportContext, what: string): ReportBody {
  return { subtitle: [ctx.range.label], meta: bankMeta(ctx, null), sections: [{ kind: 'text', paragraphs: [`Select a bank account to build the ${what}.`] }], signatories: [], validations: [], isEmpty: true };
}

/** Month of the report: the month param, else the month of the as-of date (same fiscal year). */
function reportMonth(ctx: ReportContext): number {
  if (ctx.params.month) return ctx.params.month;
  const to = ctx.range.to;
  return to.startsWith(String(ctx.params.fiscalYear)) ? Number(to.slice(5, 7)) : 12;
}

async function run(ctx: ReportContext, bank: WithId<BankAccountDoc>, asOf?: IsoDate): Promise<{ d: BankReconData; r: BankReconRun }> {
  const d = await loadBankReconData(ctx.ds, { barangayId: ctx.params.barangayId, bankAccountId: bank.id, fiscalYear: ctx.params.fiscalYear, month: reportMonth(ctx) });
  return { d, r: runBankRecon(d, undefined, asOf) };
}

const fmt = (v: number) => (v / 100).toFixed(2);
const statusNote = (d: BankReconData) =>
  !d.recon ? ['Preview from the current journal and statements — the reconciliation has not been prepared.'] : d.recon.status === 'FINAL' ? [] : [`Reconciliation status: ${d.recon.status.replace('_', ' ')} — not yet finalized by the Municipal Accountant.`];

// ------------------------------------------------------------------ BRS (legacy 04_BR)

/**
 * Statement of Bank Reconciliation, legacy layout: BOOK BALANCE · I. ADD / II. DEDUCT (items
 * requiring adjustment by agency) · ADJUSTED BOOK BALANCE · BANK BALANCE · I. ADD deposit in transit
 * · II. DEDUCT outstanding checks (see schedule) · ADJUSTED BANK BALANCE · proof.
 */
const BRS: ReportBuilder = {
  code: 'BRS',
  params: 'MONTH',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'bank reconciliation');
    const { d, r } = await run(ctx, bank);
    const asOf = lastDayOfMonth(ctx.params.fiscalYear, reportMonth(ctx));
    // A prepared reconciliation prints what was prepared / finalized; otherwise a live preview.
    const stored = d.recon ? (await ctx.ds.listSub<ReconItemRecord>('bankReconciliations', d.id, 'items')).sort((a, b) => a.seq - b.seq) : null;
    const items = stored ?? r.items;
    const fig = d.recon ? { book: d.recon.bookBalance, bank: d.recon.bankBalance, adjBook: d.recon.adjustedBookBalance, adjBank: d.recon.adjustedBankBalance, diff: d.recon.difference } : { book: r.bookBalance, bank: r.bankBalance, adjBook: r.adjustedBookBalance, adjBank: r.adjustedBankBalance, diff: r.difference };
    const columns = [col('label', '', 'text', { width: 3 }), col('date', 'Date', 'date'), col('particulars', 'Particular', 'text', { width: 3 }), col('detail', 'Amount', 'money'), col('amount', '', 'money')];
    const rows: ReportRow[] = [];
    const effect = (i: ReconItemRecord) => (['BANK_DEBIT_MEMO', 'BANK_CHARGES', 'OUTSTANDING_CHECK'] as ReconItemCategory[]).includes(i.category) ? -i.amount : i.amount;
    const block = (label: string, hint: string, list: ReconItemRecord[]) => {
      rows.push(row({ label, particulars: hint }, 'subheading', 1));
      if (!list.length) return rows.push(row({ particulars: 'None' }, 'note', 2));
      for (const i of list) rows.push(row({ date: i.date, particulars: [i.reference, i.name].filter(Boolean).join(' — '), detail: Math.abs(effect(i)) }, 'normal', 2));
      rows.push(row({ amount: list.reduce((t, i) => t + Math.abs(effect(i)), 0) }, 'subtotal', 1));
    };
    const bookSide = items.filter((i) => i.side === 'BOOK');
    rows.push(row({ label: 'BOOK BALANCE', date: asOf, amount: fig.book }, 'heading'));
    block('I. ADD:', '(items requiring adjustment by agency)', bookSide.filter((i) => effect(i) > 0));
    block('II. DEDUCT:', '(items requiring adjustment by agency)', bookSide.filter((i) => effect(i) < 0));
    rows.push(row({ label: 'ADJUSTED BOOK BALANCE', amount: fig.adjBook }, 'grandtotal'));
    rows.push(row({ label: '' }));
    rows.push(row({ label: 'BANK BALANCE', date: d.statement?.statementDate ?? asOf, amount: fig.bank }, 'heading'));
    const bankSide = items.filter((i) => i.side === 'BANK');
    block('I. ADD:', 'Deposit in Transit', bankSide.filter((i) => effect(i) > 0));
    const oc = bankSide.filter((i) => i.category === 'OUTSTANDING_CHECK');
    const otherDeduct = bankSide.filter((i) => i.category !== 'OUTSTANDING_CHECK' && effect(i) < 0);
    rows.push(row({ label: 'II. DEDUCT:', particulars: 'Outstanding Checks' }, 'subheading', 1));
    rows.push(row({ particulars: `(See Schedule 1) — ${oc.length} check(s)`, detail: oc.reduce((t, i) => t + i.amount, 0) }, 'normal', 2));
    for (const i of otherDeduct) rows.push(row({ date: i.date, particulars: [i.reference, i.name].filter(Boolean).join(' — '), detail: -effect(i) }, 'normal', 2));
    rows.push(row({ amount: oc.reduce((t, i) => t + i.amount, 0) + otherDeduct.reduce((t, i) => t - effect(i), 0) }, 'subtotal', 1));
    rows.push(row({ label: 'ADJUSTED BANK BALANCE', amount: fig.adjBank }, 'grandtotal'));
    rows.push(row({ label: 'Proof', amount: fig.diff }, 'total'));

    const check = computeBankReconciliation(fig.book as Centavos, fig.bank as Centavos, totalReconItems(items));
    const consistent = check.adjustedBookBalance === fig.adjBook && check.adjustedBankBalance === fig.adjBank;
    const changed = !!d.recon && d.recon.status !== 'FINAL' && (r.difference !== d.recon.difference || r.bookBalance !== d.recon.bookBalance || r.items.length !== d.recon.itemCount);
    const notes = [...statusNote(d), ...r.warnings];
    if (changed) notes.push('The journal or the statements changed since the reconciliation was prepared — prepare it again.');
    return {
      title: 'Statement of Bank Reconciliation',
      subtitle: [`as of ${longDate(asOf)}`],
      meta: bankMeta(ctx, bank),
      sections: [table(columns, rows), { kind: 'text', paragraphs: ['I HEREBY CERTIFY that this statement and supporting schedules are correct.'] }],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT'), ctx.sign('Verified and found correct', 'COA_AUDITOR')],
      validations: [
        validation(
          'BRS_BALANCED',
          check.balanced && consistent && !!d.recon,
          !d.recon ? 'The bank reconciliation has not been prepared.' : !consistent ? 'The stored totals do not agree with the reconciliation items; prepare the reconciliation again.' : check.balanced ? `Adjusted book balance equals adjusted bank balance (${peso(check.adjustedBookBalance)}).` : `Adjusted book and bank balances differ by ${peso(check.difference)}.`,
        ),
      ],
      notes,
      isEmpty: !d.recon && !d.statement && r.schedule1.length === 0 && r.schedule2.length === 0,
    };
  },
};

// ------------------------------------------------------------------ Schedules 1 and 2 (legacy 04.3 / 04.4)

const SCHED_COLS = (ref: string) => [col('date', 'DATE', 'date'), col('ref', ref, 'text', { width: 2 }), col('book', 'BOOK', 'money'), col('bank', 'BANK', 'money'), col('diff', 'DIFF', 'money'), col('remarks', 'REMARKS', 'text', { width: 2 })];
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((t, x) => t + f(x), 0);

export function schedule1Section(rows1: Schedule1Row[]): ReportSection {
  const rows: ReportRow[] = [];
  const block = (title: string, list: Schedule1Row[], total: string) => {
    rows.push(row({ date: null, ref: title }, 'subheading'));
    for (const s of list) rows.push(row({ date: s.date, ref: s.checkNumber, book: s.book, bank: s.bank, diff: s.diff, remarks: [s.remarks, s.payeeName].filter(Boolean).join(' · ') }, s.status === 'CANCELLED' ? 'note' : 'normal'));
    rows.push(row({ ref: total, book: sum(list, (s) => s.book), bank: sum(list, (s) => s.bank), diff: sum(list, (s) => s.diff) }, 'subtotal'));
  };
  const prior = rows1.filter((s) => s.priorYear);
  const current = rows1.filter((s) => !s.priorYear);
  if (prior.length) block('Prior Years', prior, 'Total Prior Years');
  block('Current Year', current, 'Total Current Year');
  rows.push(row({ ref: 'Grand Total', book: sum(rows1, (s) => s.book), bank: sum(rows1, (s) => s.bank), diff: sum(rows1, (s) => s.diff) }, 'grandtotal'));
  return table(SCHED_COLS('REF'), rows, { title: 'Checks Issued Reconciliation — Schedule 1' });
}

export function schedule2Sections(deposits: Schedule2Row[], adjustments: Schedule2Row[]): ReportSection[] {
  const body = (list: Schedule2Row[]) => [
    ...list.map((s) => row({ date: s.date, ref: [s.reference, s.particulars].filter(Boolean).join(' — '), book: s.book, bank: s.bank, diff: s.diff, remarks: s.remarks || (s.bankDate && s.bankDate !== s.date ? `Credited ${s.bankDate}` : '') })),
    row({ ref: 'Total', book: sum(list, (s) => s.book), bank: sum(list, (s) => s.bank), diff: sum(list, (s) => s.diff) }, 'total'),
  ];
  return [
    table(SCHED_COLS('PARTICULARS'), body(deposits), { title: 'Deposits Reconciliation — Schedule 2' }),
    table(SCHED_COLS('PARTICULARS'), body(adjustments), { title: 'BANK ADJUSTMENTS (debits shown negative)' }),
  ];
}

/** Schedule 1 (every check issued this year + prior-year outstanding) and Schedule 2 (deposits, bank adjustments). */
const BRS_SCHEDULES: ReportBuilder = {
  code: 'BRS_SCHEDULES',
  params: 'MONTH',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'schedules');
    const { d, r } = await run(ctx, bank);
    const asOf = lastDayOfMonth(ctx.params.fiscalYear, reportMonth(ctx));
    const ocTotal = r.totals.outstandingChecks;
    const s1Out = sum(r.schedule1.filter((s) => s.status === 'OUTSTANDING' || s.status === 'STALE'), (s) => s.diff);
    return {
      subtitle: [`as of ${longDate(asOf)}`],
      meta: bankMeta(ctx, bank),
      sections: [schedule1Section(r.schedule1), ...schedule2Sections(r.schedule2, r.adjustments)],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      notes: [
        ...statusNote(d),
        `Outstanding checks per Schedule 1: ${peso(s1Out)}${d.recon && d.recon.outstandingChecks !== ocTotal ? ` — the prepared reconciliation shows ${peso(d.recon.outstandingChecks)}; prepare it again` : ''}.`,
        ...r.warnings,
      ],
      isEmpty: r.schedule1.length === 0 && r.schedule2.length === 0 && r.adjustments.length === 0,
    };
  },
};

// ------------------------------------------------------------------ RBDCM

/** Report of Bank Debit and Credit Memos — every memo dated in the month, per bank account. */
const RBDCM: ReportBuilder = {
  code: 'RBDCM',
  params: 'MONTH',
  extras: [{ ...BANK_EXTRA, required: false }],
  async build(ctx) {
    const banks = new Map((await banksOf(ctx)).map((b) => [b.id, b]));
    const memos = (await ctx.ds.list<BankMemoRecord>('bankMemos', ctx.scope()))
      .filter((m) => m.status !== 'VOID' && inRange(m.memoDate, ctx.range) && (!ctx.params.bankAccountId || m.bankAccountId === ctx.params.bankAccountId))
      .sort((a, b) => a.memoDate.localeCompare(b.memoDate) || (a.memoNumber ?? '~').localeCompare(b.memoNumber ?? '~'));
    const columns = [
      col('date', 'Date', 'date'),
      col('number', 'Memo no.', 'text'),
      col('ref', 'Bank reference', 'text'),
      col('particulars', 'Particulars', 'text', { width: 3 }),
      col('account', 'Account code', 'code'),
      col('debit', 'Debit memo', 'money', { group: 'Amount' }),
      col('credit', 'Credit memo', 'money', { group: 'Amount' }),
      col('jev', 'JEV no.', 'text'),
    ];
    const sections: ReportSection[] = [];
    let unrecorded = 0;
    for (const bankId of [...new Set(memos.map((m) => m.bankAccountId))]) {
      const list = memos.filter((m) => m.bankAccountId === bankId);
      const rows = list.map((m) => {
        if (!m.jevNumber) unrecorded++;
        return row({ date: m.memoDate, number: m.memoNumber ?? '(draft)', ref: m.bankReference, particulars: m.particulars, account: m.classificationAccountCode, debit: m.memoType === 'DEBIT' ? m.amount : null, credit: m.memoType === 'CREDIT' ? m.amount : null, jev: m.jevNumber ?? '' });
      });
      const total = (t: 'DEBIT' | 'CREDIT') => list.filter((m) => m.memoType === t).reduce((s, m) => s + m.amount, 0) as Centavos;
      rows.push(row({ particulars: 'TOTAL', debit: total('DEBIT'), credit: total('CREDIT') }, 'total'));
      const b = banks.get(bankId);
      sections.push(table(columns, rows, { title: b ? bankLabel(b) : bankId }));
    }
    if (!sections.length) sections.push(table(columns, [], { emptyText: 'No bank debit or credit memos this month.' }));
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections,
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      notes: unrecorded ? [`${unrecorded} memo(s) are not yet posted to the books (no JEV number).`] : [],
      isEmpty: memos.length === 0,
    };
  },
};

// ------------------------------------------------------------------ checks encashed (legacy 04.2)

/** Checks Cleared / Encashed — the check debits on this month's bank statement, with the book entry they cleared. */
const CHECKS_CLEARED: ReportBuilder = {
  code: 'CHECKS_CLEARED',
  params: 'MONTH',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'report');
    const { d, r } = await run(ctx, bank);
    const matchByLine = new Map(r.matches.map((m) => [m.lineId, m]));
    const s1 = new Map(r.schedule1.map((s) => [s.key, s]));
    const lines = (d.statement?.lines ?? []).filter((l) => lineCheckNo(l) && inRange(l.date, ctx.range));
    let bookTotal = 0;
    const rows = lines.map((l, k) => {
      const m = matchByLine.get(l.lineId);
      const s = m ? s1.get(m.bookKey) : undefined;
      bookTotal += s?.book ?? 0;
      return row({
        no: k + 1, cleared: l.date, check: l.checkNumber || l.reference || lineCheckNo(l), date: s?.date ?? null, payee: s?.payeeName ?? '', dv: s?.dvNumber ?? '', book: s?.book ?? null, amount: l.debit,
        remarks: !s ? (r.lineClasses[l.lineId]?.cls === 'CLEARED_PRIOR' ? 'Prior item not in the books' : 'Not in the books') : s.priorYear ? 'Prior year' : s.book !== l.debit ? `Recorded at ${fmt(s.book)}` : '',
      });
    });
    if (rows.length) rows.push(row({ payee: 'TOTAL', book: bookTotal, amount: lines.reduce((t, l) => t + l.debit, 0) }, 'total'));
    return {
      subtitle: [ctx.range.label],
      meta: bankMeta(ctx, bank),
      sections: [
        table(
          [col('no', 'No.', 'number', { width: 1 }), col('cleared', 'Date encashed', 'date'), col('check', 'Check No.', 'code'), col('date', 'Check date', 'date'), col('payee', 'Payee', 'text', { width: 3 }), col('dv', 'DV No.', 'code'), col('book', 'Per books', 'money'), col('amount', 'Debit amount', 'money'), col('remarks', 'Remarks', 'text', { width: 2 })],
          rows,
          { emptyText: d.statement ? 'No checks were encashed this month.' : 'No bank statement has been entered for this month.' },
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      notes: lines.some((l) => !matchByLine.has(l.lineId)) ? ['Checks marked "Not in the books" are reconciling items requiring adjustment by the agency.'] : [],
      isEmpty: lines.length === 0,
    };
  },
};

// ------------------------------------------------------------------ outstanding checks

/** Schedule of outstanding checks as of a date (prior years included), days outstanding and stale flag. */
const OUTSTANDING_CHECKS: ReportBuilder = {
  code: 'OUTSTANDING_CHECKS',
  params: 'AS_OF',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'schedule');
    const asOf = ctx.range.to.startsWith(String(ctx.params.fiscalYear)) ? ctx.range.to : `${ctx.params.fiscalYear}-12-31`;
    const { r } = await run(ctx, bank, asOf);
    const list = r.schedule1.filter((s) => s.status === 'OUTSTANDING' || s.status === 'STALE');
    const stale = list.filter((s) => s.status === 'STALE');
    const rows = list.map((s, k) => row({ no: k + 1, date: s.date, check: s.checkNumber, payee: s.payeeName, dv: s.dvNumber, amount: s.diff, days: daysFrom(s.date, asOf), remarks: [s.priorYear ? 'Prior year' : '', s.status === 'STALE' ? 'STALE' : ''].filter(Boolean).join(' · ') }));
    if (rows.length) rows.push(row({ payee: 'TOTAL', amount: sum(list, (s) => s.diff) }, 'total'));
    return {
      subtitle: [`As of ${longDate(asOf)}`],
      meta: bankMeta(ctx, bank),
      sections: [
        table(
          [col('no', 'No.', 'number', { width: 1 }), col('date', 'Check date', 'date'), col('check', 'Check No.', 'code'), col('payee', 'Payee', 'text', { width: 3 }), col('dv', 'DV No.', 'code'), col('amount', 'Amount', 'money'), col('days', 'Days outstanding', 'number'), col('remarks', 'Remarks', 'text')],
          rows,
          { emptyText: 'No outstanding checks.' },
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      notes: [
        ...(stale.length ? [`${stale.length} check(s) totalling ${peso(sum(stale, (s) => s.diff))} are stale (more than six months old) and should be cancelled and taken back up in the books.`] : []),
        ...r.warnings,
      ],
      isEmpty: list.length === 0,
    };
  },
};

// ------------------------------------------------------------------ checks issued (legacy 04.1), used by CHECKS_ISSUED

/** Checks issued in [from, to] per the journal (+ cancelled checks at 0), with the JEV particulars. */
export async function checksIssuedRows(ctx: ReportContext, bank: WithId<BankAccountDoc>, range: { from: IsoDate; to: IsoDate }) {
  const month = Number(range.to.slice(5, 7));
  const d = await loadBankReconData(ctx.ds, { barangayId: ctx.params.barangayId, bankAccountId: bank.id, fiscalYear: ctx.params.fiscalYear, month });
  const { items } = bankBookItems(d, range.to);
  return items.filter((b) => b.kind === 'CHECK' && !b.priorYear && inRange(b.date, range));
}

/** JEV headers (particulars) by id — status filter keeps the query valid for auditors. */
export async function jevHeaders(ctx: ReportContext): Promise<Map<string, WithId<JournalEntryDoc>>> {
  const rows = await ctx.ds.list<JournalEntryDoc>('journalEntries', [['barangayId', '==', ctx.params.barangayId], ['fiscalYear', '==', ctx.params.fiscalYear], ['status', 'in', ['POSTED', 'REVERSED']]]);
  return new Map(rows.map((j) => [j.id, j]));
}

export { banksOf as bankAccountsOf, bankLabel };
export const BANK_REPORTS: ReportBuilder[] = [BRS, BRS_SCHEDULES, RBDCM, CHECKS_CLEARED, OUTSTANDING_CHECKS];
