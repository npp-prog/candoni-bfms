import {
  MONTH_NAMES,
  TB_VARIANTS,
  abnormalBalances,
  buildTrialBalance,
  formatPesos,
  reconcileSubsidiaries,
  tbMonths,
  type ReportParams,
} from '@bfms/shared';
import { useMemo, useState, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AccountInput, SubsidiarySelect } from '../../components/forms';
import { ModuleTabs } from '../../components/register';
import { reportHref } from '../../components/source';
import { Field, Icon, PageHeader, Spinner, StatusChip } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useChartOfAccounts } from '../../hooks/useChartOfAccounts';
import { useBalances } from './useBalances';

const ACCOUNT_RE = /^\d-\d{2}-\d{2}-\d{3}$/;

function defaultMonth(fiscalYear: number): number {
  const now = new Date();
  return now.getFullYear() === fiscalYear ? now.getMonth() + 1 : 12;
}

function MonthSelect({ value, onChange, ...p }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & { value: number; onChange(m: number): void }) {
  return (
    <select {...p} className="input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
    </select>
  );
}

/** A small card that collects the report parameters and opens the report viewer. */
function Launcher({ code, title, description, params, disabled, children }: { code: string; title: string; description: string; params: Partial<ReportParams>; disabled?: string | null; children?: ReactNode }) {
  return (
    <section className="card flex flex-col p-4" aria-labelledby={`l-${code}`}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 id={`l-${code}`} className="card-title">{title}</h2>
          <p className="mt-0.5 text-sm text-slate-600">{description}</p>
        </div>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{code}</span>
      </div>
      <div className="grid flex-1 gap-3 sm:grid-cols-2">{children}</div>
      <div className="mt-4 flex items-center justify-end gap-3">
        {disabled && <span className="text-xs text-slate-600">{disabled}</span>}
        {disabled ? (
          <button type="button" className="btn-primary" disabled>Open report</button>
        ) : (
          <Link className="btn-primary" to={reportHref(code, params)}><Icon name="file" /> Open report</Link>
        )}
      </div>
    </section>
  );
}

/** On-screen Trial Balance check for the selected month (same pure function the TB report uses). */
function TbSummaryCard({ month }: { month: number }) {
  const { barangayId, fiscalYear } = useBarangay();
  const coa = useChartOfAccounts();
  const { rows, loading, error } = useBalances(barangayId, fiscalYear);
  const s = useMemo(() => {
    if (!coa) return null;
    const tb = buildTrialBalance(rows, coa, tbMonths('MONTHLY', month));
    const upto = rows.filter((b) => b.month <= month);
    const slAccounts = [...new Set(upto.filter((b) => b.subsidiaryId !== null).map((b) => b.accountCode))];
    const slBad = slAccounts.filter((code) => !reconcileSubsidiaries(upto, code, coa.get(code)?.normalBalance ?? 'DEBIT').reconciled);
    return { tb, abnormal: abnormalBalances(tb), slAccounts: slAccounts.length, slBad };
  }, [rows, coa, month]);
  return (
    <section className="card mb-4 p-4" aria-labelledby="tb-sum" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="tb-sum" className="card-title">Trial balance as of {MONTH_NAMES[month - 1]} {fiscalYear}</h2>
        {s && <StatusChip status={s.tb.balanced ? 'PASSED' : 'FAILED'} />}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">Could not load balances: {error.message}</p>
      ) : loading || !s ? (
        <Spinner label="Loading balances…" />
      ) : s.tb.rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No posted entries yet for FY {fiscalYear}.</p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-slate-600">Total debits</dt><dd className="font-semibold tabular-nums">{formatPesos(s.tb.totalDebit, { symbol: true })}</dd></div>
          <div><dt className="text-xs text-slate-600">Total credits</dt><dd className="font-semibold tabular-nums">{formatPesos(s.tb.totalCredit, { symbol: true })}</dd></div>
          <div>
            <dt className="text-xs text-slate-600">Accounts with balances</dt>
            <dd className="font-semibold">{s.tb.rows.length}{s.abnormal.length > 0 && <span className="ml-1 text-xs font-medium text-amber-800">({s.abnormal.length} abnormal)</span>}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-600">Subsidiary ledgers</dt>
            <dd className={`font-semibold ${s.slBad.length ? 'text-red-700' : ''}`}>{s.slBad.length ? `${s.slBad.length} of ${s.slAccounts} differ from GL` : `${s.slAccounts} account(s) agree with GL`}</dd>
          </div>
          {!s.tb.balanced && <p role="alert" className="col-span-full text-sm font-medium text-red-700">Out of balance by {formatPesos((s.tb.totalDebit - s.tb.totalCredit), { symbol: true })}. Review the most recent postings.</p>}
          {s.abnormal.length > 0 && <p className="col-span-full text-xs text-amber-900">Abnormal: {s.abnormal.slice(0, 5).map((r) => r.accountCode).join(', ')}{s.abnormal.length > 5 ? ' …' : ''} — see the notes on the Trial Balance report.</p>}
        </dl>
      )}
    </section>
  );
}

function JournalsTab({ month, setMonth }: { month: number; setMonth(m: number): void }) {
  const { fiscalYear } = useBarangay();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Launcher code="JCT" title="Journal of Cash Transactions" description="Posted cash receipts and disbursements: Cash–Local Treasury, Cash in Bank and other accounts." params={{ fiscalYear, month }}>
        <Field label="Month">{(p) => <MonthSelect {...p} value={month} onChange={setMonth} />}</Field>
      </Launcher>
      <Launcher code="GJ" title="General Journal" description="Posted non-cash entries: liquidations, accruals, depreciation, adjustments and opening balances." params={{ fiscalYear, month }}>
        <Field label="Month">{(p) => <MonthSelect {...p} value={month} onChange={setMonth} />}</Field>
      </Launcher>
    </div>
  );
}

function LedgersTab({ month, setMonth }: { month: number; setMonth(m: number): void }) {
  const { barangayId, fiscalYear } = useBarangay();
  const [gl, setGl] = useState('1-01-02-010');
  const [coverage, setCoverage] = useState<'MONTH' | 'YEAR'>('MONTH');
  const [sl, setSl] = useState('1-01-01-010');
  const [sub, setSub] = useState<string | null>(null);
  if (!barangayId) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Launcher code="GL" title="General Ledger" description="Beginning balance, the month's postings and the running balance of one account." params={{ fiscalYear, month, accountCode: gl, variant: coverage }} disabled={ACCOUNT_RE.test(gl) ? null : 'Enter an account code.'}>
        <Field label="Account" required className="sm:col-span-2">{(p) => <AccountInput {...p} value={gl} onChange={setGl} />}</Field>
        <Field label="Month">{(p) => <MonthSelect {...p} value={month} onChange={setMonth} />}</Field>
        <Field label="Coverage">
          {(p) => (
            <select {...p} className="input" value={coverage} onChange={(e) => setCoverage(e.target.value as 'MONTH' | 'YEAR')}>
              <option value="MONTH">This month only</option>
              <option value="YEAR">January to this month + monthly summary</option>
            </select>
          )}
        </Field>
      </Launcher>
      <Launcher code="SL" title="Subsidiary Ledger" description="Per accountable officer, bank account, payee or employee; reconciled to the controlling account." params={{ fiscalYear, month, accountCode: sl, subsidiaryId: sub ?? undefined }} disabled={ACCOUNT_RE.test(sl) ? null : 'Enter a controlling account.'}>
        <Field label="Controlling account" required className="sm:col-span-2">{(p) => <AccountInput {...p} value={sl} onChange={(v) => { setSl(v); setSub(null); }} />}</Field>
        <Field label="Month">{(p) => <MonthSelect {...p} value={month} onChange={setMonth} />}</Field>
        <Field label="Subsidiary">{(p) => (ACCOUNT_RE.test(sl) ? <SubsidiarySelect {...p} barangayId={barangayId} accountCode={sl} value={sub} onChange={setSub} emptyLabel="All subsidiaries" /> : <p className="text-xs text-slate-600">Enter an account first.</p>)}</Field>
      </Launcher>
    </div>
  );
}

function TrialBalanceTab({ month, setMonth }: { month: number; setMonth(m: number): void }) {
  const { fiscalYear } = useBarangay();
  const [variant, setVariant] = useState<string>('MONTHLY');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Launcher code="TB" title="Trial Balance" description="Monthly (opening + January to the month), pre-closing or post-closing; flags abnormal balances." params={{ fiscalYear, month, variant }}>
        <Field label="Trial balance">
          {(p) => (
            <select {...p} className="input" value={variant} onChange={(e) => setVariant(e.target.value)}>
              {TB_VARIANTS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          )}
        </Field>
        {variant === 'MONTHLY' ? <Field label="As of the end of">{(p) => <MonthSelect {...p} value={month} onChange={setMonth} />}</Field> : <p className="self-end text-xs text-slate-600">As of December 31, {fiscalYear}.</p>}
      </Launcher>
      <section className="card p-4" aria-labelledby="tb-help">
        <h2 id="tb-help" className="card-title">Which trial balance?</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li><strong>Monthly</strong> — opening balances plus postings from January to the month; submitted with the monthly books.</li>
          <li><strong>Pre-closing</strong> — all of the year&apos;s postings before the closing entries; the basis of the financial statements.</li>
          <li><strong>Post-closing</strong> — after revenue and expense accounts are closed to equity; only real accounts remain.</li>
        </ul>
      </section>
    </div>
  );
}

function SchedulesTab({ month, setMonth }: { month: number; setMonth(m: number): void }) {
  const { fiscalYear } = useBarangay();
  const [acct, setAcct] = useState('');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Launcher code="SCHEDULE_OF_ACCOUNTS" title="Schedule of Accounts" description="Subsidiary balances that make up each controlling account, with the difference to the general ledger." params={{ fiscalYear, month, accountCode: acct || undefined }} disabled={acct && !ACCOUNT_RE.test(acct) ? 'Enter a valid account code or leave it blank.' : null}>
        <Field label="Controlling account" hint="Leave blank for every account with subsidiary ledgers." className="sm:col-span-2">{(p) => <AccountInput {...p} value={acct} onChange={setAcct} />}</Field>
        <Field label="As of the end of">{(p) => <MonthSelect {...p} value={month} onChange={setMonth} />}</Field>
      </Launcher>
      <section className="card p-4" aria-labelledby="jev-help">
        <h2 id="jev-help" className="card-title">Journal Entry Vouchers</h2>
        <p className="mt-1 text-sm text-slate-600">Print a JEV from the journal entry register (open the entry, then “Print JEV”), or pick it in the report viewer.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="btn-secondary" to="/accounting">Journal entry register</Link>
          <Link className="btn-secondary" to={reportHref('JEV', { fiscalYear })}><Icon name="file" /> JEV form</Link>
        </div>
      </section>
    </div>
  );
}

/** Phase 8 — Books of accounts: launchers for the journals, ledgers, trial balance and schedules. */
export function BooksPage() {
  const { barangayLabel, fiscalYear } = useBarangay();
  const [month, setMonth] = useState(() => defaultMonth(fiscalYear));
  const props = { month, setMonth };
  return (
    <>
      <PageHeader
        title="Books of Accounts"
        subtitle={`${barangayLabel} · FY ${fiscalYear}`}
        breadcrumbs={['BFMS', 'Accounting', 'Books']}
        actions={
          <>
            <Link className="btn-secondary" to="/accounting">Journal entries</Link>
            <Link className="btn-secondary" to="/statements">Financial statements</Link>
          </>
        }
      />
      <TbSummaryCard month={month} />
      <ModuleTabs
        label="Books of accounts"
        tabs={[
          { to: '/books/journals', label: 'Journals' },
          { to: '/books/ledgers', label: 'Ledgers' },
          { to: '/books/trial-balance', label: 'Trial balance' },
          { to: '/books/schedules', label: 'Schedules' },
        ]}
      />
      <Routes>
        <Route index element={<Navigate to="journals" replace />} />
        <Route path="journals" element={<JournalsTab {...props} />} />
        <Route path="ledgers" element={<LedgersTab {...props} />} />
        <Route path="trial-balance" element={<TrialBalanceTab {...props} />} />
        <Route path="schedules" element={<SchedulesTab {...props} />} />
      </Routes>
    </>
  );
}
