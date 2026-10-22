import { RECON_CATEGORY_LABELS, daysFrom, isOutstandingAt, isStaleCheck, type ReconItemRecord } from '../../accounting/bankMatching';
import { computeBankReconciliation, totalReconItems } from '../../accounting/bankRecon';
import { lastDayOfMonth } from '../../accounting/periods';
import { bankPeriodDocId, type BankMemoRecord, type BankReconciliationRecord } from '../../modules/bank';
import type { BankAccountDoc, ReconItemCategory } from '../../types/bank';
import type { Centavos } from '../../types/common';
import type { CheckDoc, DisbursementVoucherDoc } from '../../types/treasury';
import type { ExtraParam, ReportBuilder, ReportContext } from '../context';
import type { WithId } from '../datasource';
import { inRange, peso } from '../helpers';
import { col, longDate, row, table, validation, type ReportRow, type ReportSection } from '../model';

const BANK_EXTRA: ExtraParam = { key: 'bankAccountId', label: 'Bank account', kind: 'bankAccount', required: true };
/** Up to this many items are itemised inside the BRS; more are summarised (see BRS_SCHEDULES). */
const BRS_ITEMISE_LIMIT = 15;

/** The bank account asked for, else the barangay's first active account (monthly package runs). */
async function bankOf(ctx: ReportContext): Promise<WithId<BankAccountDoc> | null> {
  const banks = await ctx.ds.list<BankAccountDoc>('bankAccounts', [['barangayId', '==', ctx.params.barangayId]]);
  if (ctx.params.bankAccountId) return banks.find((b) => b.id === ctx.params.bankAccountId) ?? null;
  return banks.filter((b) => b.active).sort((a, b) => a.subsidiaryId.localeCompare(b.subsidiaryId))[0] ?? null;
}

function bankMeta(b: BankAccountDoc | null) {
  if (!b) return [{ label: 'Bank account', value: '(none selected)' }];
  return [
    { label: 'Name of bank', value: [b.bankName, b.branch].filter(Boolean).join(' – ') },
    { label: 'Account name', value: b.accountName },
    { label: 'Account no.', value: b.accountNumber },
    { label: 'Fund', value: b.fundId === 'GF' ? 'General Fund' : b.fundId },
  ];
}

function noBank(ctx: ReportContext, code: string) {
  return {
    subtitle: [ctx.range.label],
    meta: bankMeta(null),
    sections: [{ kind: 'text' as const, paragraphs: [`Select a bank account to build the ${code}.`] }],
    signatories: [],
    validations: [],
    isEmpty: true,
  };
}

/** Checks of one bank account across fiscal years (outstanding checks carry over). */
async function bankChecks(ctx: ReportContext, bankAccountId: string) {
  return ctx.ds.list<CheckDoc>('checks', [['barangayId', '==', ctx.params.barangayId], ['bankAccountId', '==', bankAccountId]]);
}

/** DV numbers of the given DV ids (one read each; reports list few checks). */
async function dvNumbers(ctx: ReportContext, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const docs = await Promise.all(unique.map((id) => ctx.ds.get<DisbursementVoucherDoc>('disbursementVouchers', id).catch(() => null)));
  return new Map(docs.flatMap((d) => (d?.dvNumber ? [[d.id, d.dvNumber] as [string, string]] : [])));
}

async function loadRecon(ctx: ReportContext, bankAccountId: string) {
  const id = bankPeriodDocId(ctx.params.barangayId, bankAccountId, ctx.params.fiscalYear, ctx.params.month ?? 1);
  const recon = await ctx.ds.get<BankReconciliationRecord>('bankReconciliations', id);
  const items = recon ? (await ctx.ds.listSub<ReconItemRecord>('bankReconciliations', id, 'items')).sort((a, b) => a.seq - b.seq) : [];
  return { recon, items };
}

function notFinalNote(recon: BankReconciliationRecord | null): string[] {
  if (!recon) return [];
  return recon.status === 'FINAL' ? [] : [`Reconciliation status: ${recon.status.replace('_', ' ')} — not yet finalized by the Municipal Accountant.`];
}

/**
 * Statement of Bank Reconciliation — two-sided (adjusted balance) method, legacy layout:
 * balance per bank ± deposits in transit / outstanding checks = adjusted bank balance;
 * balance per books ± memos, charges, interest, errors = adjusted book balance.
 */
const BRS: ReportBuilder = {
  code: 'BRS',
  params: 'MONTH',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'bank reconciliation');
    const { recon, items } = await loadRecon(ctx, bank.id);
    const asOf = lastDayOfMonth(ctx.params.fiscalYear, ctx.params.month ?? 1);
    const subtitle = [`As of ${longDate(asOf)}`];
    const signatories = [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT'), ctx.sign('Verified and found correct', 'COA_AUDITOR')];
    if (!recon)
      return {
        title: 'Statement of Bank Reconciliation',
        subtitle,
        meta: bankMeta(bank),
        sections: [{ kind: 'text', paragraphs: ['No bank reconciliation has been prepared for this bank account and month.'] }],
        signatories,
        validations: [validation('BRS_BALANCED', 'WARNING', 'The bank reconciliation has not been prepared.')],
        isEmpty: true,
      };
    const columns = [col('particulars', 'Particulars', 'text', { width: 3 }), col('date', 'Date', 'date'), col('reference', 'Reference', 'text'), col('detail', 'Amount', 'money'), col('amount', 'Total', 'money')];
    const rows: ReportRow[] = [];
    const byCat = (c: ReconItemCategory) => items.filter((i) => i.category === c);
    /** "Add:/Less:" block — itemised (or summarised) detail and its total in the right column. */
    const block = (label: string, cats: ReconItemCategory[]) => {
      for (const c of cats) {
        const list = byCat(c);
        if (!list.length) continue;
        const total = list.reduce((t, i) => t + i.amount, 0);
        rows.push(row({ particulars: `${label} ${RECON_CATEGORY_LABELS[c]}` }, 'subheading', 1));
        if (list.length <= BRS_ITEMISE_LIMIT)
          for (const i of list) rows.push(row({ particulars: i.name || RECON_CATEGORY_LABELS[c], date: i.date, reference: i.reference, detail: i.amount }, 'normal', 2));
        else rows.push(row({ particulars: `${list.length} items — see Bank Reconciliation Schedules`, detail: total }, 'note', 2));
        rows.push(row({ particulars: `Total ${RECON_CATEGORY_LABELS[c].toLowerCase()}`, amount: total }, 'subtotal', 1));
      }
    };
    rows.push(row({ particulars: `Balance per bank statement, ${longDate(recon.statementDate ?? asOf)}`, amount: recon.bankBalance }, 'heading'));
    block('Add:', ['DEPOSIT_IN_TRANSIT']);
    block('Less:', ['OUTSTANDING_CHECK']);
    block('Add/(Deduct):', ['BANK_ERROR', 'OTHER_BANK']);
    rows.push(row({ particulars: 'ADJUSTED BANK BALANCE', amount: recon.adjustedBankBalance }, 'grandtotal'));
    rows.push(row({ particulars: '' }));
    rows.push(row({ particulars: `Balance per books, ${longDate(asOf)}`, amount: recon.bookBalance }, 'heading'));
    block('Add:', ['BANK_CREDIT_MEMO', 'INTEREST_INCOME']);
    block('Less:', ['BANK_DEBIT_MEMO', 'BANK_CHARGES']);
    block('Add/(Deduct):', ['BOOK_ERROR', 'OTHER_BOOK']);
    rows.push(row({ particulars: 'ADJUSTED BOOK BALANCE', amount: recon.adjustedBookBalance }, 'grandtotal'));
    if (recon.difference !== 0) rows.push(row({ particulars: 'Unreconciled difference (book − bank)', amount: recon.difference }, 'total'));

    // Re-derive from the stored items so the printed statement can be trusted on its own.
    const check = computeBankReconciliation(recon.bookBalance, recon.bankBalance, totalReconItems(items));
    const consistent = check.adjustedBookBalance === recon.adjustedBookBalance && check.adjustedBankBalance === recon.adjustedBankBalance;
    return {
      title: 'Statement of Bank Reconciliation',
      subtitle,
      meta: [...bankMeta(bank), { label: 'Status', value: recon.status.replace('_', ' ') }],
      sections: [table(columns, rows)],
      signatories,
      validations: [
        validation(
          'BRS_BALANCED',
          check.balanced && consistent,
          !consistent ? 'The stored totals do not agree with the reconciliation items; prepare the reconciliation again.' : check.balanced ? `Adjusted book balance equals adjusted bank balance (${peso(check.adjustedBookBalance)}).` : `Adjusted book and bank balances differ by ${peso(check.difference)}.`,
        ),
      ],
      notes: notFinalNote(recon),
      isEmpty: false,
    };
  },
};

/** Schedules supporting the BRS: outstanding checks, deposits in transit, memos, errors. */
const BRS_SCHEDULES: ReportBuilder = {
  code: 'BRS_SCHEDULES',
  params: 'MONTH',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'schedules');
    const { recon, items } = await loadRecon(ctx, bank.id);
    const asOf = lastDayOfMonth(ctx.params.fiscalYear, ctx.params.month ?? 1);
    const checkItems = items.filter((i) => i.category === 'OUTSTANDING_CHECK');
    const checks = checkItems.length ? new Map((await bankChecks(ctx, bank.id)).map((c) => [c.id, c])) : new Map<string, WithId<CheckDoc>>();
    const dvs = await dvNumbers(ctx, checkItems.map((i) => (i.sourceId ? checks.get(i.sourceId)?.dvId : null)));
    const sections: ReportSection[] = [];
    const schedule = (title: string, cats: ReconItemCategory[], withDv = false) => {
      const list = items.filter((i) => cats.includes(i.category));
      const columns = [
        col('no', 'No.', 'number', { width: 1 }),
        col('date', 'Date', 'date'),
        col('reference', cats.includes('OUTSTANDING_CHECK') ? 'Check no.' : 'Reference', 'text'),
        col('name', cats.includes('OUTSTANDING_CHECK') ? 'Payee' : 'Particulars', 'text', { width: 3 }),
        ...(withDv ? [col('dv', 'DV no.', 'text'), col('days', 'Days outstanding', 'number')] : [col('remarks', 'Remarks', 'text', { width: 2 })]),
        col('amount', 'Amount', 'money'),
      ];
      const rows = list.map((i, k) => {
        const c = withDv && i.sourceCollection === 'checks' && i.sourceId ? checks.get(i.sourceId) : undefined;
        return row(withDv ? { no: k + 1, date: i.date, reference: i.reference, name: i.name, dv: c?.dvId ? dvs.get(c.dvId) ?? '' : '', days: daysFrom(i.date, asOf), amount: i.amount } : { no: k + 1, date: i.date, reference: i.reference, name: i.name, remarks: [RECON_CATEGORY_LABELS[i.category], i.remarks].filter(Boolean).join(' — '), amount: i.amount });
      });
      if (list.length) rows.push(row({ name: 'TOTAL', amount: list.reduce((t, i) => t + i.amount, 0) }, 'total'));
      sections.push(table(columns, rows, { title, emptyText: 'None.' }));
    };
    schedule('Schedule 1 — Outstanding checks', ['OUTSTANDING_CHECK'], true);
    schedule('Schedule 2 — Deposits in transit', ['DEPOSIT_IN_TRANSIT']);
    schedule('Schedule 3 — Credit memos and interest not yet taken up in the books', ['BANK_CREDIT_MEMO', 'INTEREST_INCOME']);
    schedule('Schedule 4 — Debit memos and bank charges not yet taken up in the books', ['BANK_DEBIT_MEMO', 'BANK_CHARGES']);
    schedule('Schedule 5 — Errors and other reconciling items', ['BOOK_ERROR', 'OTHER_BOOK', 'BANK_ERROR', 'OTHER_BANK']);
    return {
      subtitle: [`As of ${longDate(asOf)}`],
      meta: [...bankMeta(bank), ...(recon ? [{ label: 'Status', value: recon.status.replace('_', ' ') }] : [])],
      sections,
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      notes: recon ? notFinalNote(recon) : ['No bank reconciliation has been prepared for this bank account and month.'],
      isEmpty: !recon || items.length === 0,
    };
  },
};

/** Report of Bank Debit and Credit Memos — every memo dated in the month, per bank account. */
const RBDCM: ReportBuilder = {
  code: 'RBDCM',
  params: 'MONTH',
  extras: [{ ...BANK_EXTRA, required: false }],
  async build(ctx) {
    const banks = new Map((await ctx.ds.list<BankAccountDoc>('bankAccounts', [['barangayId', '==', ctx.params.barangayId]])).map((b) => [b.id, b]));
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
      const sum = (t: 'DEBIT' | 'CREDIT') => list.filter((m) => m.memoType === t).reduce((s, m) => s + m.amount, 0) as Centavos;
      rows.push(row({ particulars: 'TOTAL', debit: sum('DEBIT'), credit: sum('CREDIT') }, 'total'));
      const b = banks.get(bankId);
      sections.push(table(columns, rows, { title: b ? `${b.bankName} — ${b.accountName} (${b.accountNumber})` : bankId }));
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

/** Checks cleared / encashed — checks the bank paid during the month (from FINAL reconciliations). */
const CHECKS_CLEARED: ReportBuilder = {
  code: 'CHECKS_CLEARED',
  params: 'MONTH',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'report');
    const cleared = (await bankChecks(ctx, bank.id)).filter((c) => inRange(c.clearedDate, ctx.range)).sort((a, b) => (a.clearedDate ?? '').localeCompare(b.clearedDate ?? '') || a.checkNumber.localeCompare(b.checkNumber));
    const dvs = await dvNumbers(ctx, cleared.map((c) => c.dvId));
    const rows = cleared.map((c, k) => row({ no: k + 1, cleared: c.clearedDate, date: c.checkDate, check: c.checkNumber, payee: c.payee?.name ?? '', dv: c.dvId ? dvs.get(c.dvId) ?? '' : '', amount: c.amount }));
    if (rows.length) rows.push(row({ payee: 'TOTAL', amount: cleared.reduce((t, c) => t + c.amount, 0) }, 'total'));
    return {
      subtitle: [ctx.range.label],
      meta: bankMeta(bank),
      sections: [
        table(
          [col('no', 'No.', 'number', { width: 1 }), col('cleared', 'Date cleared', 'date'), col('date', 'Check date', 'date'), col('check', 'Check no.', 'text'), col('payee', 'Payee', 'text', { width: 3 }), col('dv', 'DV no.', 'text'), col('amount', 'Amount', 'money')],
          rows,
          { emptyText: 'No checks cleared this month.' },
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      isEmpty: cleared.length === 0,
    };
  },
};

/** Schedule of outstanding checks as of a date, with days outstanding and stale (> 6 months) flags. */
const OUTSTANDING_CHECKS: ReportBuilder = {
  code: 'OUTSTANDING_CHECKS',
  params: 'AS_OF',
  extras: [BANK_EXTRA],
  async build(ctx) {
    const bank = await bankOf(ctx);
    if (!bank) return noBank(ctx, 'schedule');
    const asOf = ctx.range.to;
    const list = (await bankChecks(ctx, bank.id)).filter((c) => isOutstandingAt(c, c.checkDate, asOf)).sort((a, b) => a.checkDate.localeCompare(b.checkDate) || a.checkNumber.localeCompare(b.checkNumber));
    const dvs = await dvNumbers(ctx, list.map((c) => c.dvId));
    let stale = 0;
    let staleAmount = 0;
    const rows = list.map((c, k) => {
      const isStale = isStaleCheck(c.checkDate, asOf);
      if (isStale) (stale++, (staleAmount += c.amount));
      return row({ no: k + 1, date: c.checkDate, check: c.checkNumber, payee: c.payee?.name ?? '', dv: c.dvId ? dvs.get(c.dvId) ?? '' : '', amount: c.amount, days: daysFrom(c.checkDate, asOf), remarks: isStale ? 'STALE' : '' });
    });
    if (rows.length) rows.push(row({ payee: 'TOTAL', amount: list.reduce((t, c) => t + c.amount, 0) }, 'total'));
    return {
      subtitle: [ctx.range.label],
      meta: bankMeta(bank),
      sections: [
        table(
          [col('no', 'No.', 'number', { width: 1 }), col('date', 'Check date', 'date'), col('check', 'Check no.', 'text'), col('payee', 'Payee', 'text', { width: 3 }), col('dv', 'DV no.', 'text'), col('amount', 'Amount', 'money'), col('days', 'Days outstanding', 'number'), col('remarks', 'Remarks', 'text')],
          rows,
          { emptyText: 'No outstanding checks.' },
        ),
      ],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      notes: stale ? [`${stale} check(s) totalling ${peso(staleAmount)} are stale (more than six months old) and should be cancelled and taken back up in the books.`] : [],
      isEmpty: list.length === 0,
    };
  },
};

export const BANK_REPORTS: ReportBuilder[] = [BRS, BRS_SCHEDULES, RBDCM, CHECKS_CLEARED, OUTSTANDING_CHECKS];
