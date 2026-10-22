import { abnormalBalances, buildTrialBalance, reconcileSubsidiaries } from '../../accounting/balances';
import { computeJournalTotals, normalSignedBalance } from '../../accounting/journal';
import { lastDayOfMonth } from '../../accounting/periods';
import { JEV_SOURCE_LABELS, TB_VARIANTS, tbMonths } from '../../modules/books';
import type { AccountBalanceDoc, JournalEntryDoc, JournalLineDoc } from '../../types/accounting';
import type { Centavos } from '../../types/common';
import type { ReportBody, ReportBuilder, ReportContext } from '../context';
import type { Filter, WithId } from '../datasource';
import { periodBalances, peso } from '../helpers';
import { col, longDate, MONTH_NAMES, row, table, validation, type ReportRow, type ReportSection } from '../model';
import { STATEMENT_REPORTS } from './statements';

/**
 * Phase 8 — Books of accounts (JCT, GJ, GL, SL, JEV, TB, Schedule of Accounts).
 * Journals and ledgers read POSTED journal lines (collection group `lines`) through the existing
 * composite indexes (barangayId, fiscalYear, posted, journal|accountCode[, subsidiaryId], jevDate);
 * balances come from the `accountBalances` period aggregates (periods 00 opening … 13 closing).
 */

const CIT = '1-01-01-010';
const CIB = '1-01-02-010';

/** Posted lines of a fiscal year, matching one of the `lines` composite indexes exactly. */
export async function bookLines(ctx: ReportContext, extra: readonly Filter[], fiscalYear = ctx.params.fiscalYear): Promise<WithId<JournalLineDoc>[]> {
  const rows = await ctx.ds.listGroup<JournalLineDoc>(
    'lines',
    [['barangayId', '==', ctx.params.barangayId], ['fiscalYear', '==', fiscalYear], ['posted', '==', true], ...extra],
    [['jevDate', 'asc']],
  );
  return rows.sort((a, b) => a.accountingPeriod.localeCompare(b.accountingPeriod) || a.jevDate.localeCompare(b.jevDate) || (a.jevNumber ?? '').localeCompare(b.jevNumber ?? '') || a.lineNo - b.lineNo);
}

/** Posted (and later reversed) JEV headers of the year by id — particulars and source for the books. */
export async function postedJevs(ctx: ReportContext, fiscalYear = ctx.params.fiscalYear): Promise<Map<string, WithId<JournalEntryDoc>>> {
  // Status filter keeps the query valid for auditors (rules allow them POSTED/REVERSED only).
  const rows = await ctx.ds.list<JournalEntryDoc>('journalEntries', [['barangayId', '==', ctx.params.barangayId], ['fiscalYear', '==', fiscalYear], ['status', 'in', ['POSTED', 'REVERSED']]]);
  return new Map(rows.map((j) => [j.id, j]));
}

const monthOf = (l: { accountingPeriod: string }) => Number(l.accountingPeriod.slice(5, 7));
const periodText = (fy: number, m: number) => `${fy}-${String(m).padStart(2, '0')}`;

function sourceText(j: Pick<JournalEntryDoc, 'sourceModule' | 'secondaryReference' | 'primaryReference' | 'entryType'> | undefined): string {
  if (!j) return '';
  if (j.sourceModule === 'MANUAL') return j.entryType === 'REGULAR' ? '' : j.entryType.toLowerCase();
  return [JEV_SOURCE_LABELS[j.sourceModule] ?? j.sourceModule, j.secondaryReference ?? j.primaryReference].filter(Boolean).join(' ');
}

/** JEV_BALANCED over the lines in scope, grouped by JEV. */
function jevBalanceCheck(lines: readonly JournalLineDoc[]): { ok: boolean; bad: string[]; count: number } {
  const by = new Map<string, JournalLineDoc[]>();
  for (const l of lines) by.set(l.jevId, [...(by.get(l.jevId) ?? []), l]);
  const bad = [...by.values()].filter((ls) => !computeJournalTotals(ls).balanced).map((ls) => ls[0]!.jevNumber ?? ls[0]!.jevId);
  return { ok: bad.length === 0, bad, count: by.size };
}

function empty(message: string, subtitle: string[] = []): ReportBody {
  return { subtitle, meta: [], sections: [{ kind: 'text', paragraphs: [message] }], signatories: [], validations: [], isEmpty: true };
}

const certify = (ctx: ReportContext) => [ctx.sign('Certified correct', 'MUNICIPAL_ACCOUNTANT')];

// ------------------------------------------------------------------ JCT

/** Journal of Cash Transactions — legacy columns: Cash-Local Treasury, Cash in Bank, Other accounts. */
const JCT: ReportBuilder = {
  code: 'JCT',
  params: 'MONTH',
  async build(ctx) {
    const m = ctx.params.month ?? 1;
    const key = periodText(ctx.params.fiscalYear, m);
    const [all, jevs, accounts] = await Promise.all([bookLines(ctx, [['journal', '==', 'JCT']]), postedJevs(ctx), ctx.accounts()]);
    const lines = all.filter((l) => l.accountingPeriod === key);
    const byJev = new Map<string, JournalLineDoc[]>();
    for (const l of lines) byJev.set(l.jevId, [...(byJev.get(l.jevId) ?? []), l]);
    const columns = [
      col('date', 'Date', 'date'),
      col('jev', 'JEV No.', 'code'),
      col('ref1', 'Check / OR No.', 'text'),
      col('ref2', 'DV / RCD No.', 'text'),
      col('payee', 'Payee / Particulars', 'text', { width: 3 }),
      col('citDr', 'Debit', 'money', { group: `Cash - Local Treasury (${CIT})` }),
      col('citCr', 'Credit', 'money', { group: `Cash - Local Treasury (${CIT})` }),
      col('cibDr', 'Debit', 'money', { group: `Cash in Bank (${CIB})` }),
      col('cibCr', 'Credit', 'money', { group: `Cash in Bank (${CIB})` }),
      col('acct', 'Account code', 'code', { group: 'Other accounts' }),
      col('othDr', 'Debit', 'money', { group: 'Other accounts' }),
      col('othCr', 'Credit', 'money', { group: 'Other accounts' }),
    ];
    const rows: ReportRow[] = [];
    const t = { citDr: 0, citCr: 0, cibDr: 0, cibCr: 0, othDr: 0, othCr: 0 };
    for (const ls of byJev.values()) {
      const h = jevs.get(ls[0]!.jevId);
      const sum = (code: string, k: 'debit' | 'credit') => ls.filter((l) => l.accountCode === code).reduce((s, l) => s + l[k], 0);
      const cash = { citDr: sum(CIT, 'debit'), citCr: sum(CIT, 'credit'), cibDr: sum(CIB, 'debit'), cibCr: sum(CIB, 'credit') };
      const others = ls.filter((l) => l.accountCode !== CIT && l.accountCode !== CIB);
      const payee = ls.find((l) => l.payeeName)?.payeeName;
      const particulars = h?.particulars ?? ls[0]!.lineDescription;
      const first = {
        date: ls[0]!.jevDate,
        jev: ls[0]!.jevNumber,
        ref1: ls[0]!.primaryReference,
        ref2: ls[0]!.secondaryReference,
        payee: payee ? `${payee} — ${particulars}` : particulars,
        citDr: cash.citDr || null,
        citCr: cash.citCr || null,
        cibDr: cash.cibDr || null,
        cibCr: cash.cibCr || null,
      };
      if (!others.length) rows.push(row(first));
      others.forEach((l, i) => {
        const other = { acct: l.accountCode, othDr: l.debit || null, othCr: l.credit || null };
        rows.push(row(i === 0 ? { ...first, ...other } : { payee: accounts.get(l.accountCode)?.accountName ?? '', ...other }, 'normal', i === 0 ? undefined : 1));
      });
      for (const k of ['citDr', 'citCr', 'cibDr', 'cibCr'] as const) t[k] += cash[k];
      t.othDr += others.reduce((s, l) => s + l.debit, 0);
      t.othCr += others.reduce((s, l) => s + l.credit, 0);
    }
    rows.push(row({ payee: 'TOTALS', ...t }, 'grandtotal'));
    const chk = jevBalanceCheck(lines);
    const totalDr = t.citDr + t.cibDr + t.othDr;
    const totalCr = t.citCr + t.cibCr + t.othCr;
    const ok = chk.ok && totalDr === totalCr;
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }, { label: 'Entries', value: String(byJev.size) }],
      sections: [table(columns, rows, { emptyText: 'No posted cash transactions this month.' })],
      signatories: certify(ctx),
      validations: [validation('JEV_BALANCED', ok, ok ? `All ${chk.count} cash entries balance; total debits = total credits (${peso(totalDr)}).` : chk.bad.length ? `Unbalanced entries: ${chk.bad.join(', ')}.` : `Column totals differ: debits ${peso(totalDr)}, credits ${peso(totalCr)}.`)],
      isEmpty: lines.length === 0,
    };
  },
};

// ------------------------------------------------------------------ GJ

/** General Journal — one block per JEV: debits, then indented credits, then the explanation. */
const GJ: ReportBuilder = {
  code: 'GJ',
  params: 'MONTH',
  async build(ctx) {
    const key = periodText(ctx.params.fiscalYear, ctx.params.month ?? 1);
    const [all, jevs, accounts] = await Promise.all([bookLines(ctx, [['journal', '==', 'GJ']]), postedJevs(ctx), ctx.accounts()]);
    const lines = all.filter((l) => l.accountingPeriod === key);
    const byJev = new Map<string, JournalLineDoc[]>();
    for (const l of lines) byJev.set(l.jevId, [...(byJev.get(l.jevId) ?? []), l]);
    const columns = [
      col('date', 'Date', 'date'),
      col('jev', 'JEV No.', 'code'),
      col('particulars', 'Particulars', 'text', { width: 4 }),
      col('acct', 'Account code', 'code'),
      col('dr', 'Debit', 'money'),
      col('cr', 'Credit', 'money'),
    ];
    const rows: ReportRow[] = [];
    let dr = 0;
    let cr = 0;
    for (const ls of byJev.values()) {
      const h = jevs.get(ls[0]!.jevId);
      const ordered = [...ls.filter((l) => l.debit > 0), ...ls.filter((l) => l.debit === 0)];
      ordered.forEach((l, i) => {
        const title = accounts.get(l.accountCode)?.accountName ?? l.accountCode;
        rows.push(row({ date: i === 0 ? l.jevDate : null, jev: i === 0 ? l.jevNumber : null, particulars: l.lineDescription && l.lineDescription !== title ? `${title} — ${l.lineDescription}` : title, acct: l.accountCode, dr: l.debit || null, cr: l.credit || null }, 'normal', l.credit > 0 ? 2 : undefined));
        dr += l.debit;
        cr += l.credit;
      });
      const src = sourceText(h);
      rows.push(row({ particulars: `(${h?.particulars ?? ''}${src ? ` — ${src}` : ''})` }, 'note', 1));
    }
    rows.push(row({ particulars: 'TOTALS', dr, cr }, 'grandtotal'));
    const chk = jevBalanceCheck(lines);
    const ok = chk.ok && dr === cr;
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }, { label: 'Entries', value: String(byJev.size) }],
      sections: [table(columns, rows, { emptyText: 'No posted general journal entries this month.' })],
      signatories: certify(ctx),
      validations: [validation('JEV_BALANCED', ok, ok ? `All ${chk.count} entries balance (${peso(dr)}).` : `Unbalanced entries: ${chk.bad.join(', ') || 'totals differ'}.`)],
      isEmpty: lines.length === 0,
    };
  },
};

// ------------------------------------------------------------------ GL

const GL_VARIANTS = [
  { value: 'MONTH', label: 'This month only' },
  { value: 'YEAR', label: 'January to this month, with monthly summary' },
];

function rollup(bals: readonly AccountBalanceDoc[], code: string, sl: string | null, from: number, to: number) {
  let d = 0;
  let c = 0;
  for (const b of bals) if (b.accountCode === code && b.subsidiaryId === sl && b.month >= from && b.month <= to) { d += b.debit; c += b.credit; }
  return { d, c };
}

/** General Ledger of one account: beginning balance, the month's postings, running balance on the normal side. */
const GL: ReportBuilder = {
  code: 'GL',
  params: 'MONTH',
  extras: [
    { key: 'accountCode', label: 'Account', kind: 'account', required: true },
    { key: 'variant', label: 'Coverage', kind: 'select', options: GL_VARIANTS },
  ],
  async build(ctx) {
    const code = ctx.params.accountCode;
    if (!code) return empty('Select an account to print its General Ledger.', [ctx.range.label]);
    const fy = ctx.params.fiscalYear;
    const m = ctx.params.month ?? 1;
    const year = ctx.params.variant === 'YEAR';
    const start = year ? 1 : m;
    const [accounts, bals, all, jevs] = await Promise.all([ctx.accounts(), periodBalances(ctx), bookLines(ctx, [['accountCode', '==', code]]), postedJevs(ctx)]);
    const acct = accounts.get(code);
    const normal = acct?.normalBalance ?? 'DEBIT';
    const nb = (d: number, c: number) => normalSignedBalance(d as Centavos, c as Centavos, normal);
    const lines = all.filter((l) => monthOf(l) >= start && monthOf(l) <= m);
    const open = rollup(bals, code, null, 0, start - 1);
    let bal = nb(open.d, open.c);
    const columns = [
      col('date', 'Date', 'date'),
      col('jev', 'JEV No.', 'code'),
      col('particulars', 'Particulars', 'text', { width: 4 }),
      col('ref', 'Reference', 'text'),
      col('dr', 'Debit', 'money'),
      col('cr', 'Credit', 'money'),
      col('bal', `Balance (${normal === 'DEBIT' ? 'Dr' : 'Cr'})`, 'money'),
    ];
    const rows: ReportRow[] = [row({ date: `${fy}-${String(start).padStart(2, '0')}-01`, particulars: start === 1 ? 'Beginning balance, January 1' : 'Balance forwarded', bal }, 'subheading')];
    let dr = 0;
    let cr = 0;
    for (let mm = start; mm <= m; mm++) {
      const ml = lines.filter((l) => monthOf(l) === mm);
      for (const l of ml) {
        bal = (bal + nb(l.debit, l.credit)) as Centavos;
        const h = jevs.get(l.jevId);
        rows.push(row({ date: l.jevDate, jev: l.jevNumber, particulars: h?.particulars ?? l.lineDescription, ref: [l.primaryReference, l.secondaryReference].filter(Boolean).join(' / ') || null, dr: l.debit || null, cr: l.credit || null, bal }));
        dr += l.debit;
        cr += l.credit;
      }
      if (year) rows.push(row({ particulars: `Total — ${MONTH_NAMES[mm - 1]}`, dr: ml.reduce((s, l) => s + l.debit, 0), cr: ml.reduce((s, l) => s + l.credit, 0), bal }, 'subtotal'));
    }
    rows.push(row({ particulars: year ? 'TOTAL, January to date' : 'TOTAL', dr, cr, bal }, 'grandtotal'));
    const sections: ReportSection[] = [table(columns, rows, { title: `${code} — ${acct?.accountName ?? 'Unknown account'}` })];
    if (year) {
      const sumRows: ReportRow[] = [];
      let run = nb(rollup(bals, code, null, 0, 0).d, rollup(bals, code, null, 0, 0).c);
      sumRows.push(row({ month: 'Beginning balance', bal: run }, 'subheading'));
      for (let mm = 1; mm <= m; mm++) {
        const x = rollup(bals, code, null, mm, mm);
        run = (run + nb(x.d, x.c)) as Centavos;
        sumRows.push(row({ month: MONTH_NAMES[mm - 1]!, dr: x.d || null, cr: x.c || null, bal: run }));
      }
      sections.push(table([col('month', 'Month', 'text', { width: 2 }), col('dr', 'Debit', 'money'), col('cr', 'Credit', 'money'), col('bal', 'Balance', 'money')], sumRows, { title: 'Monthly summary' }));
    }
    // Ledger postings must agree with the period aggregates the TB uses.
    const agg = rollup(bals, code, null, start, m);
    const notes = agg.d !== dr || agg.c !== cr ? [`Postings listed (Dr ${peso(dr)} / Cr ${peso(cr)}) differ from the period balances (Dr ${peso(agg.d)} / Cr ${peso(agg.c)}).`] : [];
    return {
      subtitle: [year ? `For the period January 1 to ${longDate(lastDayOfMonth(fy, m))}` : ctx.range.label],
      meta: [{ label: 'Account', value: `${code} ${acct?.accountName ?? ''}`.trim() }, { label: 'Fund', value: 'General Fund' }],
      sections,
      signatories: certify(ctx),
      validations: [],
      notes,
      isEmpty: lines.length === 0 && open.d === 0 && open.c === 0,
    };
  },
};

// ------------------------------------------------------------------ SL

/** Subsidiary Ledger: one card per SL of the account (or the SL picked), reconciled to the GL. */
const SL: ReportBuilder = {
  code: 'SL',
  params: 'MONTH',
  extras: [
    { key: 'accountCode', label: 'Controlling account', kind: 'account', required: true },
    { key: 'subsidiaryId', label: 'Subsidiary', kind: 'subsidiary' },
  ],
  async build(ctx) {
    const code = ctx.params.accountCode;
    if (!code) return empty('Select a controlling account to print its Subsidiary Ledgers.', [ctx.range.label]);
    const m = ctx.params.month ?? 1;
    const pick = ctx.params.subsidiaryId || null;
    const [accounts, subs, balsAll, all, jevs] = await Promise.all([
      ctx.accounts(),
      ctx.subsidiaries(),
      periodBalances(ctx),
      bookLines(ctx, pick ? [['accountCode', '==', code], ['subsidiaryId', '==', pick]] : [['accountCode', '==', code]]),
      postedJevs(ctx),
    ]);
    const acct = accounts.get(code);
    const normal = acct?.normalBalance ?? 'DEBIT';
    const nb = (d: number, c: number) => normalSignedBalance(d as Centavos, c as Centavos, normal);
    const bals = balsAll.filter((b) => b.accountCode === code && b.month <= m);
    const lines = all.filter((l) => monthOf(l) === m);
    const ids = pick
      ? [pick]
      : [...new Set([...bals.filter((b) => b.subsidiaryId).map((b) => b.subsidiaryId!), ...[...subs.values()].filter((s) => s.accountCode === code && s.active).map((s) => s.id)])].sort((a, b) =>
          (subs.get(a)?.subsidiaryCode ?? a).localeCompare(subs.get(b)?.subsidiaryCode ?? b),
        );
    const columns = [
      col('date', 'Date', 'date'),
      col('jev', 'JEV No.', 'code'),
      col('particulars', 'Particulars', 'text', { width: 4 }),
      col('ref', 'Reference', 'text'),
      col('dr', 'Debit', 'money'),
      col('cr', 'Credit', 'money'),
      col('bal', 'Balance', 'money'),
    ];
    const sections: ReportSection[] = [];
    let any = false;
    const card = (title: string, sl: string | null, ls: JournalLineDoc[]) => {
      const o = rollup(bals, code, sl, 0, m - 1);
      let bal = nb(o.d, o.c);
      const rows: ReportRow[] = [row({ date: ctx.range.from, particulars: m === 1 ? 'Beginning balance, January 1' : 'Balance forwarded', bal }, 'subheading')];
      for (const l of ls) {
        bal = (bal + nb(l.debit, l.credit)) as Centavos;
        rows.push(row({ date: l.jevDate, jev: l.jevNumber, particulars: l.lineDescription || jevs.get(l.jevId)?.particulars || '', ref: [l.primaryReference, l.secondaryReference].filter(Boolean).join(' / ') || null, dr: l.debit || null, cr: l.credit || null, bal }));
      }
      rows.push(row({ particulars: 'TOTAL', dr: ls.reduce((s, l) => s + l.debit, 0), cr: ls.reduce((s, l) => s + l.credit, 0), bal }, 'total'));
      if (ls.length || o.d || o.c) any = true;
      sections.push(table(columns, rows, { title }));
    };
    for (const id of ids) {
      const s = subs.get(id);
      card(`${s?.subsidiaryCode ?? id} — ${s?.subsidiaryName ?? '(unknown subsidiary)'}`, id, lines.filter((l) => l.subsidiaryId === id));
    }
    // Postings without an SL are listed so the difference to the GL is visible.
    const orphan = lines.filter((l) => !l.subsidiaryId);
    if (!pick && orphan.length) card('(No subsidiary ledger)', '__none__', orphan);
    const rec = reconcileSubsidiaries(bals, code, normal);
    const required = acct?.requiresSubsidiaryLedger ?? false;
    const v = rec.reconciled
      ? validation('SL_EQUALS_GL', true, `Σ subsidiary ledgers ${peso(rec.subsidiaryTotal)} = general ledger ${peso(rec.controlBalance)}.`)
      : validation('SL_EQUALS_GL', required ? false : 'WARNING', `Σ subsidiary ledgers ${peso(rec.subsidiaryTotal)} ≠ general ledger ${peso(rec.controlBalance)} (difference ${peso(rec.difference)})${required ? '' : '; this account does not require subsidiary ledgers'}.`);
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Controlling account', value: `${code} ${acct?.accountName ?? ''}`.trim() }, { label: 'Fund', value: 'General Fund' }],
      sections: sections.length ? sections : [table(columns, [], { emptyText: 'No subsidiary ledgers for this account.' })],
      signatories: certify(ctx),
      validations: [v],
      isEmpty: !any,
    };
  },
};

// ------------------------------------------------------------------ JEV form

/** Journal Entry Voucher (MFMB form): header, account distribution, prepared/certified/approved boxes. */
const JEV: ReportBuilder = {
  code: 'JEV',
  params: 'DOCUMENT',
  document: { collection: 'journalEntries', numberField: 'jevNumber', dateField: 'jevDate', labelField: 'particulars' },
  async build(ctx) {
    const id = ctx.params.documentId;
    const j = id ? await ctx.ds.get<JournalEntryDoc>('journalEntries', id) : null;
    if (!j || j.barangayId !== ctx.params.barangayId) return empty('Journal entry not found for this barangay.');
    const [lines, accounts, subs] = await Promise.all([ctx.ds.listSub<JournalLineDoc>('journalEntries', j.id, 'lines', [['lineNo', 'asc']]), ctx.accounts(), ctx.subsidiaries()]);
    const ordered = [...lines.filter((l) => l.debit > 0), ...lines.filter((l) => l.debit === 0)];
    const totals = computeJournalTotals(lines);
    const rows: ReportRow[] = ordered.map((l) => {
      const s = l.subsidiaryId ? subs.get(l.subsidiaryId) : undefined;
      return row({ title: `${accounts.get(l.accountCode)?.accountName ?? l.accountCode}${s ? ` — ${s.subsidiaryCode}` : ''}${l.lineDescription ? ` (${l.lineDescription})` : ''}`, code: l.accountCode, dr: l.debit || null, cr: l.credit || null }, 'normal', l.credit > 0 ? 2 : undefined);
    });
    rows.push(row({ title: 'TOTAL', dr: totals.totalDebit, cr: totals.totalCredit }, 'grandtotal'));
    const book = j.journal === 'JCT' ? 'Journal of Cash Transactions' : 'General Journal';
    const draft = j.status !== 'POSTED' && j.status !== 'REVERSED';
    return {
      subtitle: [draft ? `${j.status.replace(/_/g, ' ')} — not yet posted` : ''].filter(Boolean),
      meta: [],
      sections: [
        {
          kind: 'fields',
          columns: 4,
          fields: [
            { label: 'Entity name', value: `Barangay ${ctx.barangayName}`, span: 2 },
            { label: 'JEV No.', value: j.jevNumber ?? '(assigned on posting)' },
            { label: 'Date', value: j.jevDate, type: 'date' },
            { label: 'Fund cluster', value: j.fundId === 'GF' ? 'General Fund' : j.fundId },
            { label: 'Book', value: book },
            { label: 'Entry type', value: j.entryType.charAt(0) + j.entryType.slice(1).toLowerCase() },
            { label: 'Source', value: sourceText(j) || 'Manual entry' },
            { label: 'Check / OR No.', value: j.primaryReference ?? '' },
            { label: 'DV / RCD No.', value: j.secondaryReference ?? '' },
            { label: 'Other reference', value: j.tertiaryReference ?? '', span: 2 },
          ],
        },
        table([col('title', 'Accounts and explanation', 'text', { width: 4 }), col('code', 'Account code', 'code'), col('dr', 'Debit', 'money'), col('cr', 'Credit', 'money')], rows, { title: 'Accounting entries' }),
        { kind: 'text', title: 'Particulars', paragraphs: [j.particulars] },
        {
          kind: 'certifications',
          boxes: [
            { label: 'Prepared by', name: '', position: 'Accounting Staff', date: null },
            { label: 'Certified correct', ...signBox(ctx.sign('', 'MUNICIPAL_ACCOUNTANT', j.jevDate)), date: null },
            { label: 'Approved by', ...signBox(ctx.sign('', 'MUNICIPAL_ACCOUNTANT', j.jevDate)), date: null },
          ],
        },
      ],
      signatories: [],
      validations: [validation('JEV_BALANCED', totals.balanced && totals.totalDebit > 0, totals.balanced ? `Debits = credits = ${peso(totals.totalDebit)}.` : `Out of balance by ${peso(totals.difference)}.`)],
      isEmpty: false,
    };
  },
};

const signBox = (s: { name: string; position: string }) => ({ name: s.name, position: s.position });

// ------------------------------------------------------------------ TB

/** Trial Balance — monthly (00..m), pre-closing (00..12) or post-closing (00..13). */
const TB: ReportBuilder = {
  code: 'TB',
  params: 'MONTH',
  extras: [{ key: 'variant', label: 'Trial balance', kind: 'select', options: TB_VARIANTS.map((v) => ({ value: v.value, label: v.label })), required: true }],
  async build(ctx) {
    const fy = ctx.params.fiscalYear;
    const variant = ctx.params.variant ?? 'MONTHLY';
    const { throughMonth, includeClosing } = tbMonths(variant, ctx.params.month ?? 12);
    const [accounts, bals] = await Promise.all([ctx.accounts(), periodBalances(ctx)]);
    const tb = buildTrialBalance(bals, accounts, { throughMonth, includeClosing });
    const rows: ReportRow[] = tb.rows.map((r) => row({ title: r.accountName, code: r.accountCode, dr: r.debit || null, cr: r.credit || null }));
    rows.push(row({ title: 'TOTAL', dr: tb.totalDebit, cr: tb.totalCredit }, 'grandtotal'));
    const abnormal = abnormalBalances(tb);
    const asOf = longDate(lastDayOfMonth(fy, Math.min(throughMonth, 12)));
    const closingPosted = bals.some((b) => b.month === 13 && b.subsidiaryId === null);
    const title = variant === 'PRE_CLOSING' ? 'Pre-Closing Trial Balance' : variant === 'POST_CLOSING' ? 'Post-Closing Trial Balance' : 'Trial Balance';
    return {
      title,
      subtitle: [`As of ${asOf}`],
      meta: [{ label: 'Fund', value: 'General Fund' }, ...(variant === 'POST_CLOSING' && !closingPosted ? [{ label: 'Note', value: 'Closing entries have not been posted' }] : [])],
      sections: [table([col('title', 'Account title', 'text', { width: 4 }), col('code', 'Account code', 'code'), col('dr', 'Debit', 'money'), col('cr', 'Credit', 'money')], rows, { emptyText: 'No posted balances.' })],
      signatories: [ctx.sign('Prepared and certified correct', 'MUNICIPAL_ACCOUNTANT')],
      validations: [validation('TB_BALANCED', tb.balanced, tb.balanced ? `Total debits = total credits = ${peso(tb.totalDebit)}.` : `Debits ${peso(tb.totalDebit)} ≠ credits ${peso(tb.totalCredit)} (difference ${peso(tb.totalDebit - tb.totalCredit)}).`)],
      notes: abnormal.map((r) => `Abnormal balance: ${r.accountCode} ${r.accountName} shows a ${r.debit ? 'debit' : 'credit'} balance of ${peso(r.debit || r.credit)} (normal balance is ${r.normalBalance.toLowerCase()}).`),
      isEmpty: tb.rows.length === 0,
    };
  },
};

// ------------------------------------------------------------------ Schedule of Accounts

/** Subsidiary balances that make up a controlling account (all SL-carrying accounts when none is picked). */
const SCHEDULE_OF_ACCOUNTS: ReportBuilder = {
  code: 'SCHEDULE_OF_ACCOUNTS',
  params: 'MONTH',
  extras: [{ key: 'accountCode', label: 'Controlling account (blank = all)', kind: 'account' }],
  async build(ctx) {
    const fy = ctx.params.fiscalYear;
    const m = ctx.params.month ?? 12;
    const [accounts, subs, balsAll] = await Promise.all([ctx.accounts(), ctx.subsidiaries(), periodBalances(ctx)]);
    const bals = balsAll.filter((b) => b.month <= m);
    const codes = ctx.params.accountCode
      ? [ctx.params.accountCode]
      : [...new Set(bals.filter((b) => b.subsidiaryId !== null).map((b) => b.accountCode))].sort((a, b) => (accounts.get(a)?.sortOrder ?? 0) - (accounts.get(b)?.sortOrder ?? 0) || a.localeCompare(b));
    const columns = [col('code', 'Code', 'code'), col('name', 'Subsidiary / payee', 'text', { width: 4 }), col('bal', 'Balance', 'money')];
    const sections: ReportSection[] = [];
    const failures: string[] = [];
    for (const code of codes) {
      const acct = accounts.get(code);
      const normal = acct?.normalBalance ?? 'DEBIT';
      const slIds = [...new Set(bals.filter((b) => b.accountCode === code && b.subsidiaryId !== null).map((b) => b.subsidiaryId!))];
      const rows: ReportRow[] = slIds
        .map((id) => {
          const r = rollup(bals, code, id, 0, m);
          return { id, bal: normalSignedBalance(r.d as Centavos, r.c as Centavos, normal) };
        })
        .filter((x) => x.bal !== 0)
        .sort((a, b) => (subs.get(a.id)?.subsidiaryCode ?? a.id).localeCompare(subs.get(b.id)?.subsidiaryCode ?? b.id))
        .map((x) => row({ code: subs.get(x.id)?.subsidiaryCode ?? x.id, name: subs.get(x.id)?.subsidiaryName ?? '(unknown subsidiary)', bal: x.bal }));
      const rec = reconcileSubsidiaries(bals, code, normal);
      rows.push(row({ name: 'Total per subsidiary ledgers', bal: rec.subsidiaryTotal }, 'subtotal'));
      rows.push(row({ name: 'Balance per general ledger', bal: rec.controlBalance }, 'total'));
      if (!rec.reconciled) {
        rows.push(row({ name: 'Difference', bal: rec.difference }, 'note'));
        failures.push(`${code} (difference ${peso(rec.difference)})`);
      }
      sections.push(table(columns, rows, { title: `${code} — ${acct?.accountName ?? 'Unknown account'}` }));
    }
    return {
      subtitle: [`As of ${longDate(lastDayOfMonth(fy, m))}`],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: sections.length ? sections : [table(columns, [], { emptyText: 'No subsidiary balances.' })],
      signatories: [ctx.sign('Certified correct', 'MUNICIPAL_ACCOUNTANT')],
      validations: [validation('SL_EQUALS_GL', failures.length === 0, failures.length === 0 ? `Subsidiary ledgers agree with the general ledger for ${codes.length} account(s).` : `Subsidiary ledgers do not agree with the general ledger: ${failures.join('; ')}.`)],
      isEmpty: sections.length === 0,
    };
  },
};

export const BOOKS_REPORTS: ReportBuilder[] = [JCT, GJ, GL, SL, JEV, TB, SCHEDULE_OF_ACCOUNTS, ...STATEMENT_REPORTS];
