import { APPROPRIATION_CLASSES, EXPENSE_CLASSES } from '../../modules/budget';
import type { AppropriationDoc, EstimatedIncomeDoc, RaoEntryDoc } from '../../types/budget';
import type { CollectionDoc } from '../../types/treasury';
import type { ReportBuilder } from '../context';
import { inRange } from '../helpers';
import { col, row, table, validation, type ReportRow, type ReportSection } from '../model';

const CLASS_OPTIONS = [{ value: 'ALL', label: 'All classes' }, ...APPROPRIATION_CLASSES.map((c) => ({ value: c.value, label: c.label }))];
const classLabel = (v: string) => APPROPRIATION_CLASSES.find((c) => c.value === v)?.label ?? v;

/** Record of Appropriations and Obligations — one ledger per appropriation item, running balance. */
const RAO: ReportBuilder = {
  code: 'RAO',
  params: 'MONTH',
  extras: [{ key: 'variant', label: 'Appropriation class', kind: 'select', options: CLASS_OPTIONS.filter((o) => o.value !== 'ALL'), required: true }],
  async build(ctx) {
    const cls = ctx.params.variant ?? 'REGULAR';
    const apps = (await ctx.ds.list<AppropriationDoc>('appropriations', ctx.scope()))
      .filter((a) => a.appropriationClass === cls && ['ACTIVE', 'CLOSED'].includes(a.status))
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    const entries = (await ctx.ds.list<RaoEntryDoc>('raoEntries', ctx.scope())).filter((e) => e.date <= ctx.range.to);
    const columns = [
      col('date', 'Date', 'date'),
      col('reference', 'Reference', 'text'),
      col('particulars', 'Particulars', 'text', { width: 3 }),
      col('appropriation', 'Appropriation', 'money', { group: 'Amount' }),
      col('adjustment', 'Adjustments', 'money', { group: 'Amount' }),
      col('obligation', 'Obligations', 'money', { group: 'Amount' }),
      col('balance', 'Unobligated balance', 'money'),
    ];
    const sections: ReportSection[] = [];
    let negative = 0;
    for (const a of apps) {
      const lines = entries
        .filter((e) => e.appropriationId === a.id)
        .sort((x, y) => x.date.localeCompare(y.date) || (x.createdAt?.seconds ?? 0) - (y.createdAt?.seconds ?? 0));
      let bal = 0;
      const rows: ReportRow[] = lines.map((e) => {
        bal += e.appropriation + e.adjustment - e.obligation;
        if (bal < 0) negative++;
        return row({ date: e.date, reference: e.reference, particulars: e.particulars, appropriation: e.appropriation || null, adjustment: e.adjustment || null, obligation: e.obligation || null, balance: bal });
      });
      const t = (k: 'appropriation' | 'adjustment' | 'obligation') => lines.reduce((s, e) => s + e[k], 0);
      rows.push(row({ particulars: 'Total', appropriation: t('appropriation'), adjustment: t('adjustment'), obligation: t('obligation'), balance: bal }, 'total'));
      sections.push(table(columns, rows, { title: `${a.accountCode} ${(a as AppropriationDoc & { accountName?: string }).accountName ?? ''}${a.program ? ` — ${a.program}` : ''}`.trim() }));
    }
    return {
      subtitle: [ctx.range.label, `${classLabel(cls)} appropriations`],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: sections.length ? sections : [table(columns, [], { emptyText: 'No active appropriations in this class.' })],
      signatories: [ctx.sign('Certified correct', 'APPROPRIATIONS_CHAIR')],
      validations: [validation('OBLIGATION_WITHIN_APPROPRIATION', negative === 0, negative === 0 ? 'Every obligation is within its available appropriation.' : `${negative} ledger line(s) show a negative unobligated balance.`)],
      isEmpty: apps.length === 0,
    };
  },
};

/** Statement of Appropriations, Obligations and Balances — by expense class and account. */
const SAOB: ReportBuilder = {
  code: 'SAOB',
  params: 'MONTH',
  extras: [{ key: 'variant', label: 'Appropriation class', kind: 'select', options: CLASS_OPTIONS }],
  async build(ctx) {
    const cls = ctx.params.variant && ctx.params.variant !== 'ALL' ? ctx.params.variant : null;
    const monthStart = ctx.range.from;
    const apps = (await ctx.ds.list<AppropriationDoc>('appropriations', ctx.scope())).filter((a) => ['ACTIVE', 'CLOSED'].includes(a.status) && (!cls || a.appropriationClass === cls));
    const byId = new Map(apps.map((a) => [a.id, a]));
    const entries = (await ctx.ds.list<RaoEntryDoc>('raoEntries', ctx.scope())).filter((e) => byId.has(e.appropriationId) && e.date <= ctx.range.to);

    type Acc = { code: string; name: string; cls: string; original: number; adj: number; prior: number; current: number };
    const byAccount = new Map<string, Acc>();
    for (const a of apps) {
      const k = `${a.expenseClass}|${a.accountCode}`;
      const cur = byAccount.get(k) ?? { code: a.accountCode, name: (a as AppropriationDoc & { accountName?: string }).accountName ?? '', cls: a.expenseClass, original: 0, adj: 0, prior: 0, current: 0 };
      byAccount.set(k, cur);
    }
    for (const e of entries) {
      const a = byId.get(e.appropriationId)!;
      const acc = byAccount.get(`${a.expenseClass}|${a.accountCode}`)!;
      acc.original += e.appropriation;
      acc.adj += e.adjustment;
      if (e.date < monthStart) acc.prior += e.obligation;
      else acc.current += e.obligation;
    }
    const columns = [
      col('code', 'Account code', 'code'),
      col('name', 'Particulars', 'text', { width: 3 }),
      col('original', 'Original', 'money', { group: 'Appropriations' }),
      col('adj', 'Adjustments', 'money', { group: 'Appropriations' }),
      col('final', 'Final', 'money', { group: 'Appropriations' }),
      col('prior', 'Previous months', 'money', { group: 'Obligations' }),
      col('current', 'This month', 'money', { group: 'Obligations' }),
      col('total', 'Total', 'money', { group: 'Obligations' }),
      col('balance', 'Unobligated balance', 'money'),
    ];
    const rows: ReportRow[] = [];
    const grand = { original: 0, adj: 0, prior: 0, current: 0 };
    let over = 0;
    for (const ec of EXPENSE_CLASSES) {
      const accs = [...byAccount.values()].filter((a) => a.cls === ec.value).sort((x, y) => x.code.localeCompare(y.code));
      if (!accs.length) continue;
      rows.push(row({ code: null, name: ec.label }, 'heading'));
      const sub = { original: 0, adj: 0, prior: 0, current: 0 };
      for (const a of accs) {
        const final = a.original + a.adj;
        const total = a.prior + a.current;
        if (total > final) over++;
        rows.push(row({ code: a.code, name: a.name, original: a.original, adj: a.adj || null, final, prior: a.prior || null, current: a.current || null, total: total || null, balance: final - total }, 'normal', 1));
        for (const k of ['original', 'adj', 'prior', 'current'] as const) sub[k] += a[k];
      }
      rows.push(row({ name: `Total ${ec.label}`, original: sub.original, adj: sub.adj, final: sub.original + sub.adj, prior: sub.prior, current: sub.current, total: sub.prior + sub.current, balance: sub.original + sub.adj - sub.prior - sub.current }, 'subtotal'));
      for (const k of ['original', 'adj', 'prior', 'current'] as const) grand[k] += sub[k];
    }
    rows.push(row({ name: 'GRAND TOTAL', original: grand.original, adj: grand.adj, final: grand.original + grand.adj, prior: grand.prior, current: grand.current, total: grand.prior + grand.current, balance: grand.original + grand.adj - grand.prior - grand.current }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label, cls ? `${classLabel(cls)} appropriations` : 'All appropriation classes'],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: [table(columns, rows)],
      signatories: [ctx.sign('Prepared by', 'APPROPRIATIONS_CHAIR'), ctx.sign('Approved by', 'PUNONG_BARANGAY')],
      validations: [validation('OBLIGATION_WITHIN_APPROPRIATION', over === 0, over === 0 ? 'Obligations are within appropriations for every account.' : `${over} account(s) are obligated beyond their final appropriation.`)],
      isEmpty: apps.length === 0,
    };
  },
};

/** Record of Estimated and Actual Income — estimates vs collections (from issued ORs). */
const REAI: ReportBuilder = {
  code: 'REAI',
  params: 'MONTH',
  async build(ctx) {
    const accounts = await ctx.accounts();
    const estimates = await ctx.ds.list<EstimatedIncomeDoc & { accountName?: string }>('estimatedIncome', ctx.scope());
    const collections = (await ctx.ds.list<CollectionDoc>('collections', ctx.scope())).filter((c) => !['VOID', 'CANCELLED'].includes(c.status) && c.collectionDate <= ctx.range.to);
    const acc = new Map<string, { estimate: number; month: number; ytd: number }>();
    for (const e of estimates) acc.set(e.incomeAccountCode, { estimate: (acc.get(e.incomeAccountCode)?.estimate ?? 0) + e.estimatedIncome, month: 0, ytd: 0 });
    for (const c of collections) {
      const thisMonth = inRange(c.collectionDate, ctx.range);
      for (const l of c.lines ?? []) {
        const cur = acc.get(l.accountCode) ?? { estimate: 0, month: 0, ytd: 0 };
        cur.ytd += l.amount;
        if (thisMonth) cur.month += l.amount;
        acc.set(l.accountCode, cur);
      }
    }
    const codes = [...acc.keys()].sort();
    const rows: ReportRow[] = codes.map((code) => {
      const a = acc.get(code)!;
      return row({ code, name: accounts.get(code)?.accountName ?? code, estimate: a.estimate, month: a.month || null, ytd: a.ytd || null, balance: a.estimate - a.ytd, rate: a.estimate ? Math.round((a.ytd * 10000) / a.estimate) / 100 : null });
    });
    const tot = (k: 'estimate' | 'month' | 'ytd') => codes.reduce((s, c) => s + acc.get(c)![k], 0);
    rows.push(row({ name: 'TOTAL', estimate: tot('estimate'), month: tot('month'), ytd: tot('ytd'), balance: tot('estimate') - tot('ytd'), rate: tot('estimate') ? Math.round((tot('ytd') * 10000) / tot('estimate')) / 100 : null }, 'grandtotal'));
    return {
      subtitle: [ctx.range.label],
      meta: [{ label: 'Fund', value: 'General Fund' }],
      sections: [
        table(
          [
            col('code', 'Account code', 'code'),
            col('name', 'Source of income', 'text', { width: 3 }),
            col('estimate', 'Estimated income', 'money'),
            col('month', 'This month', 'money', { group: 'Actual collections' }),
            col('ytd', 'To date', 'money', { group: 'Actual collections' }),
            col('balance', 'Balance to be collected', 'money'),
            col('rate', '% collected', 'percent'),
          ],
          rows,
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'BARANGAY_TREASURER')],
      validations: [],
      isEmpty: estimates.length === 0 && collections.length === 0,
    };
  },
};

export const BUDGET_REPORTS: ReportBuilder[] = [RAO, SAOB, REAI];
