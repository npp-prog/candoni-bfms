import { BARANGAYS, formatPesos, type BarangayId, type Centavos } from '@bfms/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  IMPORT_LIMITS,
  IMPORT_PARTS,
  IMPORT_PART_LABELS,
  chunk,
  chunkEntries,
  openingPayload,
  toCancelledCheckPayloads,
  toEntryPayload,
  toPpePayload,
  type ImportCancelledCheckPayload,
  type ImportCashAdvancePayload,
  type ImportEntryPayload,
  type ImportPart,
  type ImportPpePayload,
  type ImportPriorYearPayload,
  type ImportStatus,
  type ImportSubsidiaryPayload,
} from '../../../shared/src/accounting/importPayload';
import { entriesByMonth, importFingerprint, parseWorkbook, tieOut, type ImportIssue, type WorkbookImport } from '../../../shared/src/accounting/workbookImport';
import { ConfirmDialog, Field, Icon, PageHeader, Spinner } from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { useBarangay } from '../../contexts/BarangayContext';
import { useToast } from '../../contexts/ToastContext';
import { callFn, errorMessage } from '../../services/functions/api';
import { readWorkbookFile } from './xlsx';

type Rejected = { key: string; reason: string };
type EntriesResult = { posted: Array<{ key: string; jevId: string; jevNumber: string }>; skipped: string[]; rejected: Rejected[] };
type RefResult = { created: number; skipped: Array<{ id: string; reason: string }> };

const api = {
  status: callFn<{ barangayId: BarangayId; fiscalYear: number }, ImportStatus>('importStatus'),
  begin: callFn<{ barangayId: BarangayId; fiscalYear: number; parts: ImportPart[]; fingerprint: string; sourceTitle: string; counts: Record<string, number> }, { importId: string; resumed: boolean; parts: ImportPart[] }>('importBegin'),
  subsidiaries: callFn<{ importId: string; subsidiaries: ImportSubsidiaryPayload[] }, RefResult>('importSubsidiaries'),
  entries: callFn<{ importId: string; kind: 'OPENING' | 'JOURNAL'; entries: ImportEntryPayload[] }, EntriesResult>('importEntries'),
  reference: callFn<
    { importId: string; priorYears?: ImportPriorYearPayload[]; cashAdvances?: { offset: number; items: ImportCashAdvancePayload[] }; ppe?: ImportPpePayload[]; cancelledChecks?: { bankAccountId: string; items: ImportCancelledCheckPayload[] } },
    RefResult
  >('importReference'),
  finish: callFn<{ importId: string }, { status: string; progress: Record<string, Record<string, number>> }>('importFinish'),
};

const P = (c: number) => formatPesos(c as Centavos, { dashZero: false });

interface Summary {
  subsidiariesCreated: number;
  openingNumber: string | null;
  posted: number;
  skipped: number;
  rejected: Rejected[];
  firstJev: string | null;
  lastJev: string | null;
  reference: string[];
}

/**
 * Legacy workbook import (Municipal Accounting's Google Sheets books). The .xlsx is parsed in the
 * browser — nothing is uploaded to Storage — and previewed with every problem found; the
 * Municipal Accountant then imports the selected parts. Entries with errors are never sent.
 */
export function ImportPage() {
  const { can, accessibleBarangays } = useAuth();
  const ctx = useBarangay();
  const { notify } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<Record<string, unknown[][]> | null>(null);
  const [reading, setReading] = useState(false);
  const [inferDates, setInferDates] = useState(true);
  const [barangayId, setBarangayId] = useState<BarangayId | null>(ctx.barangayId);
  const [fiscalYear, setFiscalYear] = useState<number>(ctx.fiscalYear);
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [parts, setParts] = useState<Set<ImportPart>>(new Set());
  const [bankAccountId, setBankAccountId] = useState<string>('');
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ step: string; done: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);

  const parsed: WorkbookImport | null = useMemo(
    () => (sheets ? parseWorkbook(sheets, { title: file?.name ?? '', inferMissingDates: inferDates, fiscalYear: fiscalYear || undefined }) : null),
    [sheets, file, inferDates, fiscalYear],
  );

  // Pre-fill barangay / year from the workbook once.
  async function onFile(f: File | null) {
    setFile(f);
    setSheets(null);
    setSummary(null);
    setLog([]);
    if (!f) return;
    setReading(true);
    try {
      const s = await readWorkbookFile(f);
      const guess = parseWorkbook(s, { title: f.name });
      if (guess.barangayGuess && accessibleBarangays.includes(guess.barangayGuess)) setBarangayId(guess.barangayGuess);
      if (guess.fiscalYear) setFiscalYear(guess.fiscalYear);
      setSheets(s);
    } catch (e) {
      notify(`Could not read the workbook: ${errorMessage(e)}`, 'error');
    } finally {
      setReading(false);
    }
  }

  const refreshStatus = () => {
    if (!barangayId || !fiscalYear) return;
    setStatus(null);
    setStatusError(null);
    api.status({ barangayId, fiscalYear }).then(setStatus, (e) => setStatusError(errorMessage(e)));
  };
  useEffect(refreshStatus, [barangayId, fiscalYear]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = useMemo(() => {
    const a: Partial<Record<ImportPart, { count: number; reason?: string }>> = {};
    if (!parsed) return a;
    const importable = parsed.entries.filter((e) => !e.hasError);
    a.SUBSIDIARIES = { count: parsed.subsidiaries.length };
    a.OPENING = { count: parsed.opening ? 1 : 0, reason: parsed.opening?.hasError ? 'The opening entry has errors (see issues).' : undefined };
    a.JOURNAL = { count: importable.length };
    a.PRIOR_YEARS = { count: parsed.priorYears.length };
    a.CASH_ADVANCES = { count: parsed.legacyCashAdvances.length };
    a.PPE = { count: parsed.ppeSchedule.length };
    a.CANCELLED_CHECKS = { count: toCancelledCheckPayloads(parsed.cancelledChecks).length, reason: status && !status.bankAccounts.length ? 'Register the bank account in Setup first.' : undefined };
    for (const p of IMPORT_PARTS) {
      const blocked = status?.blocked[p];
      if (blocked) a[p] = { ...a[p]!, reason: blocked };
      if (!a[p]!.count) a[p] = { ...a[p]!, reason: a[p]!.reason ?? 'Nothing to import.' };
    }
    return a;
  }, [parsed, status]);

  // Default selection: everything that is available.
  useEffect(() => {
    setParts(new Set(IMPORT_PARTS.filter((p) => available[p] && !available[p]!.reason)));
  }, [available]);
  useEffect(() => {
    if (!status?.bankAccounts.length) return setBankAccountId('');
    setBankAccountId((status.bankAccounts.find((b) => b.subsidiaryCode === 'CIB01') ?? status.bankAccounts[0]!).id);
  }, [status]);

  if (!barangayId) return <Spinner />;
  const canImport = can('import.approve', barangayId) && can('jev.post', barangayId);
  const mismatch = parsed?.barangayGuess && parsed.barangayGuess !== barangayId;

  async function run() {
    if (!parsed || !barangayId) return;
    setConfirm(false);
    setRunning(true);
    setSummary(null);
    const out: Summary = { subsidiariesCreated: 0, openingNumber: null, posted: 0, skipped: 0, rejected: [], firstJev: null, lastJev: null, reference: [] };
    const say = (s: string) => setLog((l) => [...l, s]);
    try {
      const sel = IMPORT_PARTS.filter((p) => parts.has(p));
      const journal = parsed.entries.filter((e) => !e.hasError).map(toEntryPayload);
      const begin = await api.begin({ barangayId, fiscalYear, parts: sel, fingerprint: importFingerprint(parsed), sourceTitle: file?.name ?? '', counts: { entries: journal.length, subsidiaries: parsed.subsidiaries.length } });
      say(begin.resumed ? `Resuming unfinished import ${begin.importId}.` : `Import ${begin.importId} started.`);
      const id = begin.importId;
      if (parts.has('SUBSIDIARIES')) {
        const list = parsed.subsidiaries.map(({ accountCode, subsidiaryCode, subsidiaryName, type }) => ({ accountCode, subsidiaryCode, subsidiaryName, type }));
        const batches = chunk(list, IMPORT_LIMITS.subsidiariesPerCall);
        for (const [i, b] of batches.entries()) {
          setProgress({ step: 'Subsidiary ledgers', done: i, total: batches.length });
          out.subsidiariesCreated += (await api.subsidiaries({ importId: id, subsidiaries: b })).created;
        }
        say(`Subsidiary ledgers: ${out.subsidiariesCreated} created, ${list.length - out.subsidiariesCreated} already existed.`);
      }
      const track = (r: EntriesResult) => {
        out.posted += r.posted.length;
        out.skipped += r.skipped.length;
        out.rejected.push(...r.rejected);
        if (r.posted.length) {
          out.firstJev ??= r.posted[0]!.jevNumber;
          out.lastJev = r.posted[r.posted.length - 1]!.jevNumber;
        }
      };
      if (parts.has('OPENING') && parsed.opening) {
        setProgress({ step: 'Opening balances', done: 0, total: 1 });
        const r = await api.entries({ importId: id, kind: 'OPENING', entries: [openingPayload(parsed.opening, fiscalYear)] });
        track(r);
        out.openingNumber = r.posted[0]?.jevNumber ?? null;
        say(r.posted.length ? `Opening balances posted as JEV ${out.openingNumber} (period 00).` : r.skipped.length ? 'Opening balances were already posted by this import.' : `Opening balances rejected: ${r.rejected[0]?.reason ?? ''}`);
      }
      if (parts.has('JOURNAL')) {
        const batches = chunkEntries(journal);
        for (const [i, b] of batches.entries()) {
          setProgress({ step: 'Current-year journal', done: i, total: batches.length });
          track(await api.entries({ importId: id, kind: 'JOURNAL', entries: b }));
        }
        say(`Journal: ${out.posted - (out.openingNumber ? 1 : 0)} JEVs posted${out.skipped ? `, ${out.skipped} already posted` : ''}${out.rejected.length ? `, ${out.rejected.length} rejected` : ''}.`);
      }
      const ref = async (label: string, body: Omit<Parameters<typeof api.reference>[0], 'importId'>) => {
        setProgress({ step: label, done: 0, total: 1 });
        const r = await api.reference({ importId: id, ...body });
        const msg = `${label}: ${r.created} saved${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped.slice(0, 3).map((s) => `${s.id}: ${s.reason}`).join('; ')})` : ''}.`;
        out.reference.push(msg);
        say(msg);
        return r;
      };
      if (parts.has('PRIOR_YEARS')) await ref('Prior-year balances', { priorYears: parsed.priorYears.map((y) => ({ fiscalYear: y.fiscalYear, rows: y.rows })) });
      if (parts.has('CASH_ADVANCES')) {
        const items = parsed.legacyCashAdvances.map(({ sheet: _s, row: _r, ...c }) => c);
        let created = 0;
        for (const [i, b] of chunk(items, IMPORT_LIMITS.cashAdvancesPerCall).entries()) {
          setProgress({ step: 'Legacy cash advances', done: i, total: Math.ceil(items.length / IMPORT_LIMITS.cashAdvancesPerCall) });
          created += (await api.reference({ importId: id, cashAdvances: { offset: i * IMPORT_LIMITS.cashAdvancesPerCall, items: b } })).created;
        }
        const msg = `Legacy cash advances: ${created} saved.`;
        out.reference.push(msg);
        say(msg);
      }
      if (parts.has('PPE')) await ref('PPE schedule', { ppe: parsed.ppeSchedule.map(toPpePayload) });
      if (parts.has('CANCELLED_CHECKS') && bankAccountId) {
        const items = toCancelledCheckPayloads(parsed.cancelledChecks);
        for (const b of chunk(items, IMPORT_LIMITS.cancelledChecksPerCall)) await ref('Cancelled checks', { cancelledChecks: { bankAccountId, items: b } });
      }
      await api.finish({ importId: id });
      say('Import finished.');
      setSummary(out);
      notify('Workbook imported.', 'success');
    } catch (e) {
      say(`Stopped: ${errorMessage(e)}`);
      notify(errorMessage(e), 'error');
      setSummary(out);
    } finally {
      setProgress(null);
      setRunning(false);
      refreshStatus();
    }
  }

  return (
    <div>
      <PageHeader
        title="Import legacy workbook"
        subtitle="Bring a barangay's Google Sheets books (exported as .xlsx) into BFMS: SL master, opening balances, the current-year journal, prior-year balances, cash-advance list and PPE schedule."
        breadcrumbs={['Accounting', 'Import']}
      />

      <section className="card mb-4 p-4" aria-labelledby="imp-file">
        <h2 id="imp-file" className="card-title mb-3">1. Workbook</h2>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Workbook file (.xlsx)" hint="Google Sheets: File → Download → Microsoft Excel. The file is read in your browser; it is not uploaded." className="md:col-span-2">
            {(p) => <input {...p} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" disabled={running} onChange={(e) => onFile(e.target.files?.[0] ?? null)} />}
          </Field>
          <Field label="Barangay" hint={parsed?.barangayGuess ? `Workbook says ${parsed.barangayGuess}.` : undefined} error={mismatch ? `The workbook looks like ${parsed!.barangayGuess}.` : null}>
            {(p) => (
              <select {...p} className="input" value={barangayId} disabled={running} onChange={(e) => setBarangayId(e.target.value as BarangayId)}>
                {BARANGAYS.filter((b) => accessibleBarangays.includes(b.barangayId)).map((b) => <option key={b.barangayId} value={b.barangayId}>{b.barangayName}</option>)}
              </select>
            )}
          </Field>
          <Field label="Fiscal year" hint="From the PY DB opening date.">
            {(p) => <input {...p} type="number" className="input" min={2000} max={2100} value={fiscalYear} disabled={running} onChange={(e) => setFiscalYear(Number(e.target.value))} />}
          </Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={inferDates} onChange={(e) => setInferDates(e.target.checked)} disabled={running} />
          Entries without a date: assume the DV month or the previous row's date (warning) instead of rejecting them
        </label>
        {reading && <Spinner label="Reading workbook…" />}
        {statusError && <p className="field-error mt-2">{statusError}</p>}
      </section>

      {parsed && <Preview w={parsed} />}

      {parsed && (
        <section className="card mb-4 p-4" aria-labelledby="imp-run">
          <h2 id="imp-run" className="card-title mb-3">3. Import</h2>
          {!status && !statusError && <Spinner label="Checking what is already in BFMS…" />}
          {status?.inProgress && (
            <p className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              An unfinished import ({status.inProgress.importId}) by {status.inProgress.createdByName} exists. Importing the same workbook again as that user resumes it; already-posted entries are skipped.
            </p>
          )}
          <fieldset disabled={running || !status}>
            <legend className="sr-only">Parts to import</legend>
            <ul className="space-y-2">
              {IMPORT_PARTS.map((p) => {
                const a = available[p];
                return (
                  <li key={p} className="flex flex-wrap items-start gap-2 text-sm">
                    <input
                      id={`part-${p}`}
                      type="checkbox"
                      className="mt-1"
                      checked={parts.has(p)}
                      disabled={!!a?.reason}
                      onChange={(e) => setParts((s) => { const n = new Set(s); if (e.target.checked) n.add(p); else n.delete(p); return n; })}
                    />
                    <label htmlFor={`part-${p}`} className="min-w-[18rem] font-medium">{IMPORT_PART_LABELS[p]} <span className="text-slate-500">({a?.count ?? 0})</span></label>
                    {a?.reason && <span className="text-slate-600">— {a.reason}</span>}
                    {p === 'CANCELLED_CHECKS' && status && status.bankAccounts.length > 1 && (
                      <select className="input w-auto py-0.5" aria-label="Bank account of the cancelled checks" value={bankAccountId} onChange={(e) => setBankAccountId(e.target.value)}>
                        {status.bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <p className="mt-3 text-xs text-slate-600">
            Imported entries are created and posted by you in one step (source IMPORT), numbered in date order; entries with errors are not sent — encode them in Journal Entries after correcting them. Posted books are never replaced: a second import of the same journal or opening balances is refused.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" disabled={!canImport || running || !parts.size || !status} onClick={() => setConfirm(true)}>
              <Icon name="check" /> Import {parts.size} part{parts.size === 1 ? '' : 's'}
            </button>
            {!canImport && <span className="text-sm text-slate-600">Only the Municipal Accountant (import.approve + jev.post) can import; you can preview.</span>}
          </div>
          {progress && (
            <div className="mt-3" role="status">
              <p className="text-sm">{progress.step}… {progress.total > 1 ? `${progress.done + 1} of ${progress.total}` : ''}</p>
              <div className="mt-1 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-navy-700" style={{ width: `${Math.round(((progress.done + 0.5) / Math.max(progress.total, 1)) * 100)}%` }} /></div>
            </div>
          )}
          {log.length > 0 && <ol className="mt-3 list-decimal space-y-0.5 pl-6 text-sm">{log.map((l, i) => <li key={i}>{l}</li>)}</ol>}
          {summary && (
            <div className="mt-4 rounded border border-slate-200 p-3 text-sm">
              <h3 className="font-semibold">Summary</h3>
              <ul className="mt-1 list-disc pl-6">
                <li>Subsidiary ledgers created: {summary.subsidiariesCreated}</li>
                <li>JEVs created and posted: {summary.posted}{summary.firstJev ? ` (${summary.firstJev} … ${summary.lastJev})` : ''}{summary.openingNumber ? `; opening ${summary.openingNumber}` : ''}</li>
                <li>Skipped (already posted): {summary.skipped}</li>
                <li>Not imported because of errors in the workbook: {parsed.entries.filter((e) => e.hasError).length}; rejected by the server: {summary.rejected.length}</li>
                {summary.reference.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              {summary.rejected.length > 0 && (
                <ul className="mt-2 max-h-48 overflow-auto text-xs text-red-800">{summary.rejected.map((r) => <li key={r.key}>{r.key}: {r.reason}</li>)}</ul>
              )}
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirm}
        title="Import into the books?"
        message={
          <div className="space-y-2 text-sm">
            <p>Barangay <strong>{barangayId}</strong>, fiscal year <strong>{fiscalYear}</strong>.</p>
            <ul className="list-disc pl-5">{IMPORT_PARTS.filter((p) => parts.has(p)).map((p) => <li key={p}>{IMPORT_PART_LABELS[p]}</li>)}</ul>
            <p>Posted entries cannot be edited or deleted afterwards (only reversed).</p>
          </div>
        }
        confirmLabel="Import and post"
        onConfirm={run}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Preview({ w }: { w: WorkbookImport }) {
  const [sev, setSev] = useState<'ALL' | 'ERROR' | 'WARNING'>('ALL');
  const [code, setCode] = useState('');
  const [q, setQ] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const importable = w.entries.filter((e) => !e.hasError);
  const errors = w.issues.filter((i) => i.severity === 'ERROR').length;
  const months = entriesByMonth(w.entries);
  const tie = tieOut(w);
  const codes = [...new Set(w.issues.map((i) => i.code))].sort();
  const shown = w.issues.filter((i) => (sev === 'ALL' || i.severity === sev) && (!code || i.code === code) && (!q || `${i.message} ${i.row ?? ''} ${i.sheet}`.toLowerCase().includes(q.toLowerCase())));
  const sample = (showErrors ? w.entries.filter((e) => e.hasError) : w.entries).slice(0, 12);
  const issuesOf = (key: string) => w.issues.filter((i: ImportIssue) => i.entryKey === key);
  const kpi = (label: string, value: string, tone = '') => (
    <div className="rounded border border-slate-200 p-3">
      <p className="kpi-label">{label}</p>
      <p className={`kpi-value ${tone}`}>{value}</p>
    </div>
  );
  return (
    <section className="card mb-4 p-4" aria-labelledby="imp-prev">
      <h2 id="imp-prev" className="card-title mb-3">2. Preview</h2>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {kpi('Subsidiary ledgers', String(w.subsidiaries.length))}
        {kpi('Opening Dr = Cr?', w.opening ? (w.opening.balanced ? 'Balanced' : `Off by ${P(w.opening.difference)}`) : '—', w.opening && !w.opening.balanced ? 'text-red-700' : '')}
        {kpi('Entries (importable)', `${w.entries.length} (${importable.length})`, importable.length < w.entries.length ? 'text-amber-700' : '')}
        {kpi('Issues', `${errors} errors · ${w.issues.length - errors} warnings`, errors ? 'text-red-700' : '')}
        {kpi('Cancelled checks', String(w.cancelledChecks.length))}
        {kpi('Prior yrs · CAs · PPE', `${w.priorYears.length} · ${w.legacyCashAdvances.length} · ${w.ppeSchedule.length}`)}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold">Opening trial balance ({w.sheets.opening ?? 'no PY DB'})</h3>
          {w.opening ? (
            <table className="w-full text-sm">
              <tbody>
                <tr><th className="text-left font-normal">Debits</th><td className="num">{P(w.opening.totalDebit)}</td></tr>
                <tr><th className="text-left font-normal">Credits</th><td className="num">{P(w.opening.totalCredit)}</td></tr>
                <tr><th className="text-left font-normal">Lines</th><td className="num">{w.opening.lines.length}</td></tr>
              </tbody>
            </table>
          ) : <p className="text-sm text-slate-600">No opening balances found.</p>}
          <h3 className="mb-1 mt-4 text-sm font-semibold">Tie-out with the workbook's {w.fiscalYear} pre-closing TB</h3>
          {!w.workbookTb.length ? (
            <p className="text-sm text-slate-600">The workbook has no {w.fiscalYear} pre-closing TB column.</p>
          ) : tie.length === 0 ? (
            <p className="text-sm text-emerald-800">Opening + importable entries reproduce the workbook TB exactly.</p>
          ) : (
            <table className="w-full text-sm">
              <caption className="text-left text-xs text-slate-600">Accounts that will differ from the workbook (entries with errors are not imported).</caption>
              <thead><tr><th className="text-left">Account</th><th className="num">Workbook</th><th className="num">After import</th><th className="num">Difference</th></tr></thead>
              <tbody>{tie.slice(0, 15).map((t) => <tr key={t.accountCode}><td className="font-mono">{t.accountCode}</td><td className="num">{P(t.workbook)}</td><td className="num">{P(t.imported)}</td><td className="num text-red-700">{P(t.difference)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold">Entries per month</h3>
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">Month</th><th className="num">Entries</th><th className="num">With errors</th><th className="num">Debits</th></tr></thead>
            <tbody>{months.map((m) => <tr key={m.month}><td>{m.month}</td><td className="num">{m.entries}</td><td className={`num ${m.errors ? 'text-red-700' : ''}`}>{m.errors}</td><td className="num">{P(m.debit)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold">Issues</h3>
      <div className="mb-2 flex flex-wrap gap-2">
        <select className="input w-auto" aria-label="Severity" value={sev} onChange={(e) => setSev(e.target.value as typeof sev)}>
          <option value="ALL">All severities</option><option value="ERROR">Errors</option><option value="WARNING">Warnings</option>
        </select>
        <select className="input w-auto" aria-label="Issue type" value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">All types</option>
          {codes.map((c) => <option key={c} value={c}>{c} ({w.issues.filter((i) => i.code === c).length})</option>)}
        </select>
        <input className="input w-56" placeholder="Search…" aria-label="Search issues" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="max-h-80 overflow-auto rounded border border-slate-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-50"><tr><th className="text-left">Severity</th><th className="text-left">Sheet</th><th className="num">Row</th><th className="text-left">Message</th></tr></thead>
          <tbody>
            {shown.slice(0, 300).map((i, n) => (
              <tr key={n} className="border-t border-slate-100">
                <td className={i.severity === 'ERROR' ? 'font-semibold text-red-700' : 'text-amber-700'}>{i.severity}</td>
                <td>{i.sheet}</td>
                <td className="num">{i.row ?? ''}</td>
                <td>{i.message}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={4} className="p-3 text-slate-600">No issues.</td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > 300 && <p className="mt-1 text-xs text-slate-600">Showing 300 of {shown.length}; filter to narrow.</p>}

      <div className="mb-2 mt-6 flex items-center gap-4">
        <h3 className="text-sm font-semibold">Sample entries</h3>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={showErrors} onChange={(e) => setShowErrors(e.target.checked)} /> only entries with errors</label>
      </div>
      <div className="space-y-3">
        {sample.map((e) => (
          <div key={e.key} className={`rounded border p-2 text-sm ${e.hasError ? 'border-red-300 bg-red-50' : 'border-slate-200'}`}>
            <p>
              <strong>{e.date ?? 'no date'}</strong> · {e.transactionType.toLowerCase()}{e.transactionTypeInferred ? ' (inferred)' : ''} · {[e.primaryReference, e.secondaryReference, e.legacyJevNo].filter(Boolean).join(' / ')} · {e.payeeName ?? ''}
              <span className="ml-2 text-xs text-slate-600">rows {e.rows.join(', ')}</span>
            </p>
            <p className="text-slate-700">{e.particulars}</p>
            <table className="mt-1 w-full text-xs">
              <tbody>{e.lines.map((l, i) => <tr key={i}><td className="font-mono">{l.accountCode}</td><td>{l.subsidiaryCode ?? ''}</td><td className="num">{l.debit ? P(l.debit) : ''}</td><td className="num">{l.credit ? P(l.credit) : ''}</td></tr>)}</tbody>
            </table>
            {issuesOf(e.key).map((i, n) => <p key={n} className={`text-xs ${i.severity === 'ERROR' ? 'text-red-700' : 'text-amber-700'}`}>{i.message}</p>)}
          </div>
        ))}
      </div>
    </section>
  );
}
