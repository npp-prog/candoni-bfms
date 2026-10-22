import {
  MONTH_NAMES,
  overallValidation,
  reportBuilder,
  reportDefinition,
  runReport,
  type ExtraParam,
  type ReportBuilder,
  type ReportModel,
  type ReportParams,
} from '@bfms/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AccountInput, BankAccountSelect, SubsidiarySelect } from '../components/forms';
import { EmptyState, Icon, PageHeader, Spinner, StatusChip } from '../components/ui';
import { useBarangay } from '../contexts/BarangayContext';
import { useToast } from '../contexts/ToastContext';
import { useCollection } from '../hooks/useCollection';
import { clientDataSource } from '../services/datasource';
import { errorMessage } from '../services/functions/api';
import { exportReportXlsx } from './exportXlsx';
import { ReportDocument } from './ReportDocument';
import { SnapshotActions } from './SnapshotActions';

const NUM_KEYS = ['fiscalYear', 'month', 'quarter', 'semester'] as const;

function readParams(sp: URLSearchParams, barangayId: string, fiscalYear: number): ReportParams {
  const p: Record<string, unknown> = { barangayId, fiscalYear };
  sp.forEach((v, k) => {
    p[k] = (NUM_KEYS as readonly string[]).includes(k) ? Number(v) : v;
  });
  return p as unknown as ReportParams;
}

/** Are the inputs the builder needs present? */
function missing(b: ReportBuilder, p: ReportParams): string | null {
  if (b.params === 'MONTH' && !p.month) return 'Select a month.';
  if (b.params === 'QUARTER' && !p.quarter) return 'Select a quarter.';
  if (b.params === 'SEMESTER' && !p.semester) return 'Select a semester.';
  if (b.params === 'DOCUMENT' && !p.documentId) return 'Select a document.';
  for (const e of b.extras ?? []) if (e.required && !p[e.key]) return `Select ${e.label.toLowerCase()}.`;
  return null;
}

export function ReportViewerPage() {
  const { code = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const { barangayId, barangayLabel, fiscalYear } = useBarangay();
  const { notify } = useToast();
  const builder = reportBuilder(code);
  const def = reportDefinition(code);
  const params = useMemo(() => (barangayId ? readParams(sp, barangayId, fiscalYear) : null), [sp, barangayId, fiscalYear]);
  const [model, setModel] = useState<ReportModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const need = builder && params ? missing(builder, params) : null;

  // Default the month to the current one for monthly reports.
  useEffect(() => {
    if (builder?.params === 'MONTH' && !sp.get('month')) {
      const m = new Date().getFullYear() === fiscalYear ? new Date().getMonth() + 1 : 12;
      setSp((s) => { s.set('month', String(m)); return s; }, { replace: true });
    }
    for (const e of builder?.extras ?? [])
      if (e.kind === 'select' && e.required && !sp.get(e.key) && e.options?.[0]) setSp((s) => { s.set(e.key, e.options![0]!.value); return s; }, { replace: true });
  }, [builder, sp, setSp, fiscalYear]);

  useEffect(() => {
    if (!builder || !params || need) return setModel(null);
    let alive = true;
    setLoading(true);
    setError(null);
    runReport(builder, clientDataSource, params)
      .then((m) => alive && setModel(m))
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [builder, params, need]);

  if (!def) return <EmptyState title={`Unknown report ${code}`} action={<Link className="btn-secondary" to="/reports">All reports</Link>} />;
  const set = (k: string, v: string | number | null | undefined) =>
    setSp((s) => {
      if (v === null || v === undefined || v === '') s.delete(k);
      else s.set(k, String(v));
      return s;
    });

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={def.reportName}
          subtitle={`${barangayLabel} · FY ${params?.fiscalYear ?? fiscalYear}${def.formNumber ? ` · Form ${def.formNumber}` : ''}`}
          breadcrumbs={['BFMS', 'Reports', def.reportCode]}
          actions={
            <>
              <Link className="btn-ghost" to="/reports">All reports</Link>
              <button type="button" className="btn-secondary" disabled={!model} onClick={() => window.print()}>
                <Icon name="file" /> Print / PDF
              </button>
              <button type="button" className="btn-secondary" disabled={!model} onClick={() => model && void exportReportXlsx(model, `${def.reportCode}_${barangayId}_${params?.fiscalYear}${params?.month ? `-${String(params.month).padStart(2, '0')}` : ''}`).catch((e) => notify(errorMessage(e), 'error'))}>
                Excel
              </button>
              {model && params && <SnapshotActions model={model} params={params} />}
            </>
          }
        />
        {!builder ? (
          <EmptyState title="This report is not available yet." />
        ) : (
          params && <ParamBar builder={builder} params={params} set={set} />
        )}
        {model && model.validations.length > 0 && (
          <section aria-label="Validation results" className={`mb-4 rounded-md border px-4 py-3 text-sm ${overallValidation(model.validations) === 'FAILED' ? 'border-red-300 bg-red-50' : overallValidation(model.validations) === 'WARNING' ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50'}`}>
            <ul className="space-y-1">
              {model.validations.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <StatusChip status={v.result} />
                  <span className="font-mono text-xs text-slate-600">{v.id}</span>
                  <span>{v.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {need && <p className="no-print rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">{need}</p>}
      {loading && <Spinner label="Building report…" />}
      {error && <p role="alert" className="no-print rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {model && !loading && (
        <>
          <style>{`@page { size: ${model.paper.size === 'LEGAL' ? 'legal' : model.paper.size === 'LETTER' ? 'letter' : 'A4'} ${model.paper.orientation.toLowerCase()}; margin: 10mm; }`}</style>
          <ReportDocument model={model} />
        </>
      )}
    </>
  );
}

function ParamBar({ builder, params, set }: { builder: ReportBuilder; params: ReportParams; set(k: string, v: string | number | null | undefined): void }) {
  const bid = params.barangayId;
  return (
    <div className="card mb-4 flex flex-wrap items-end gap-4 p-4">
      {builder.params === 'MONTH' && (
        <div>
          <label className="label" htmlFor="p-month">Month</label>
          <select id="p-month" className="input" value={params.month ?? ''} onChange={(e) => set('month', e.target.value)}>
            {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
      )}
      {builder.params === 'QUARTER' && (
        <div>
          <label className="label" htmlFor="p-q">Quarter</label>
          <select id="p-q" className="input" value={params.quarter ?? ''} onChange={(e) => set('quarter', e.target.value)}>
            <option value="">—</option>
            {[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}
          </select>
        </div>
      )}
      {builder.params === 'SEMESTER' && (
        <div>
          <label className="label" htmlFor="p-s">Semester</label>
          <select id="p-s" className="input" value={params.semester ?? ''} onChange={(e) => set('semester', e.target.value)}>
            <option value="">—</option>
            <option value="1">January–June</option>
            <option value="2">July–December</option>
          </select>
        </div>
      )}
      {builder.params === 'AS_OF' && (
        <div>
          <label className="label" htmlFor="p-asof">As of</label>
          <input id="p-asof" type="date" className="input" value={params.asOf ?? ''} onChange={(e) => set('asOf', e.target.value)} />
        </div>
      )}
      {builder.params === 'RANGE' && (
        <>
          <div>
            <label className="label" htmlFor="p-from">From</label>
            <input id="p-from" type="date" className="input" value={params.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="p-to">To</label>
            <input id="p-to" type="date" className="input" value={params.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value)} />
          </div>
        </>
      )}
      {builder.params === 'DOCUMENT' && builder.document && <DocumentPicker builder={builder} params={params} onPick={(id) => set('documentId', id)} />}
      {(builder.extras ?? []).map((e) => (
        <ExtraInput key={e.key} e={e} params={params} barangayId={bid} set={set} />
      ))}
      {builder.params === 'YEAR' && <p className="text-sm text-slate-600">Fiscal year {params.fiscalYear}. Change the year in the top bar.</p>}
    </div>
  );
}

function DocumentPicker({ builder, params, onPick }: { builder: ReportBuilder; params: ReportParams; onPick(id: string): void }) {
  const d = builder.document!;
  const { rows, loading } = useCollection<Record<string, unknown>>(d.collection, [['barangayId', '==', params.barangayId], ['fiscalYear', '==', params.fiscalYear]]);
  const sorted = [...rows].sort((a, b) => String(b[d.dateField] ?? '').localeCompare(String(a[d.dateField] ?? '')));
  return (
    <div className="min-w-[18rem] flex-1">
      <label className="label" htmlFor="p-doc">Document</label>
      <select id="p-doc" className="input" value={params.documentId ?? ''} onChange={(e) => onPick(e.target.value)} disabled={loading}>
        <option value="">{loading ? 'Loading…' : sorted.length ? '— select —' : 'No documents this year'}</option>
        {sorted.map((r) => (
          <option key={r.id} value={r.id}>
            {String(r[d.numberField] ?? '(unnumbered)')} · {String(r[d.dateField] ?? '')}{d.labelField ? ` · ${labelOf(r[d.labelField])}` : ''} · {String(r.status ?? '')}
          </option>
        ))}
      </select>
    </div>
  );
}

function labelOf(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) return String((v as { name: unknown }).name);
  return String(v ?? '').slice(0, 60);
}

function ExtraInput({ e, params, barangayId, set }: { e: ExtraParam; params: ReportParams; barangayId: ReportParams['barangayId']; set(k: string, v: string | null | undefined): void }) {
  const id = `p-${e.key}`;
  const v = (params[e.key] as string | undefined) ?? '';
  return (
    <div className="min-w-[12rem]">
      <label className={`label ${e.required ? 'required' : ''}`} htmlFor={id}>{e.label}</label>
      {e.kind === 'select' && (
        <select id={id} className="input" value={v} onChange={(ev) => set(e.key, ev.target.value)}>
          {!e.required && <option value="">—</option>}
          {(e.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {e.kind === 'bankAccount' && <BankAccountSelect id={id} barangayId={barangayId} value={v || null} onChange={(x) => set(e.key, x)} />}
      {e.kind === 'account' && <AccountInput id={id} value={v} onChange={(x) => set(e.key, x)} />}
      {e.kind === 'subsidiary' && (params.accountCode ? <SubsidiarySelect id={id} barangayId={barangayId} accountCode={params.accountCode} value={v || null} onChange={(x) => set(e.key, x)} emptyLabel="All subsidiaries" /> : <p className="text-xs text-slate-600">Enter an account first.</p>)}
      {e.kind === 'fund' && (
        <select id={id} className="input" value={v} onChange={(ev) => set(e.key, ev.target.value)}>
          <option value="">General Fund</option>
        </select>
      )}
      {e.kind === 'inventoryItem' && <DocSelect id={id} col="inventoryItems" barangayId={barangayId} value={v} label={(r) => `${String(r.stockNumber ?? '')} — ${String(r.description ?? '')}`} onChange={(x) => set(e.key, x)} />}
      {e.kind === 'ppe' && <DocSelect id={id} col="ppe" barangayId={barangayId} value={v} label={(r) => `${String(r.propertyNumber ?? '')} — ${String(r.description ?? '')}`} onChange={(x) => set(e.key, x)} />}
    </div>
  );
}

function DocSelect({ id, col, barangayId, value, label, onChange }: { id: string; col: string; barangayId: ReportParams['barangayId']; value: string; label(r: Record<string, unknown>): string; onChange(v: string): void }) {
  const { rows } = useCollection<Record<string, unknown>>(col, [['barangayId', '==', barangayId]]);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— select —</option>
      {rows.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
    </select>
  );
}
