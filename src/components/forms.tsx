import { formatPesos, parsePesos, type BankAccountDoc, type BarangayId, type Centavos, type PartyRef, type SubsidiaryAccountDoc } from '@bfms/shared';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useChartOfAccounts } from '../hooks/useChartOfAccounts';
import { useCollection } from '../hooks/useCollection';
import { Icon } from './ui';

/**
 * Form building blocks for source-document pages. Money is always integer centavos in state;
 * inputs keep their own text so a half-typed "1,2" is not reformatted under the cursor.
 */

type InputProps = { id?: string; disabled?: boolean; 'aria-invalid'?: true; 'aria-describedby'?: string; required?: boolean; className?: string };

/** Peso amount input. `onChange(null)` while the text is not a valid amount. */
export function MoneyInput({ value, onChange, allowZero = true, ...p }: InputProps & { value: Centavos | number | null; onChange(v: Centavos | null): void; allowZero?: boolean }) {
  const [text, setText] = useState(value ? formatPesos(value as Centavos, { parens: false }) : '');
  const [bad, setBad] = useState(false);
  // Sync when the value is changed from outside (load, reset), but not while the user types.
  useEffect(() => {
    try {
      if (value !== null && parsePesos(text || '0') !== value) setText(value ? formatPesos(value as Centavos, { parens: false }) : '');
    } catch {
      /* keep the user's text */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      {...p}
      className={`input num ${p.className ?? ''}`}
      inputMode="decimal"
      placeholder="0.00"
      value={text}
      aria-invalid={bad || p['aria-invalid'] ? true : undefined}
      onChange={(e) => {
        setText(e.target.value);
        try {
          const v = parsePesos(e.target.value || '0');
          const ok = v >= 0 && (allowZero || v > 0);
          setBad(!ok);
          onChange(ok ? v : null);
        } catch {
          setBad(true);
          onChange(null);
        }
      }}
      onBlur={() => {
        try {
          const v = parsePesos(text || '0');
          if (v >= 0) setText(v ? formatPesos(v, { parens: false }) : '');
        } catch {
          /* leave as typed; aria-invalid shows the problem */
        }
      }}
    />
  );
}

/** Account code with Chart of Accounts suggestions, limited to code prefixes (e.g. ['5-', '1-07']). */
export function AccountInput({ value, onChange, prefixes, ...p }: InputProps & { value: string; onChange(code: string): void; prefixes?: readonly string[] }) {
  const coa = useChartOfAccounts();
  const listId = useId();
  const options = coa ? [...coa.values()].filter((a) => a.active && (!prefixes || prefixes.some((x) => a.accountCode.startsWith(x)))) : [];
  const acct = coa?.get(value.trim());
  return (
    <div>
      <input {...p} list={listId} className={`input font-mono ${p.className ?? ''}`} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder="0-00-00-000" />
      <datalist id={listId}>
        {options.map((a) => (
          <option key={a.accountCode} value={a.accountCode}>{a.accountName}</option>
        ))}
      </datalist>
      <p className={`mt-0.5 text-[11px] ${value && !acct ? 'text-red-700' : 'text-slate-600'}`}>{value ? acct?.accountName ?? 'Unknown account code' : ''}</p>
    </div>
  );
}

/** Subsidiary ledger picker for one controlling account (BT01, CIB01, AO02 …). */
export function SubsidiarySelect({ barangayId, accountCode, value, onChange, allowEmpty = true, emptyLabel = '— none —', ...p }: InputProps & { barangayId: BarangayId; accountCode: string; value: string | null; onChange(id: string | null): void; allowEmpty?: boolean; emptyLabel?: string }) {
  const { rows } = useCollection<SubsidiaryAccountDoc>('subsidiaryAccounts', accountCode ? [['barangayId', '==', barangayId], ['accountCode', '==', accountCode]] : null);
  const active = rows.filter((r) => r.active || r.id === value).sort((a, b) => a.subsidiaryCode.localeCompare(b.subsidiaryCode));
  return (
    <select {...p} className={`input ${p.className ?? ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {active.map((s) => (
        <option key={s.id} value={s.id}>{s.subsidiaryCode} — {s.subsidiaryName}</option>
      ))}
    </select>
  );
}

/** Bank account picker for the barangay. */
export function BankAccountSelect({ barangayId, value, onChange, ...p }: InputProps & { barangayId: BarangayId; value: string | null; onChange(id: string | null, account: (BankAccountDoc & { id: string }) | null): void }) {
  const { rows } = useCollection<BankAccountDoc>('bankAccounts', [['barangayId', '==', barangayId]]);
  return (
    <select {...p} className={`input ${p.className ?? ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value || null, rows.find((r) => r.id === e.target.value) ?? null)}>
      <option value="">— select bank account —</option>
      {rows.filter((r) => r.active || r.id === value).map((b) => (
        <option key={b.id} value={b.id}>{b.bankName} · {maskAccount(b.accountNumber)}</option>
      ))}
    </select>
  );
}

export function maskAccount(n: string): string {
  return n.length <= 4 ? n : `••••${n.slice(-4)}`;
}

/** Payee / payor: name (required), TIN and address (optional). */
export function PartyInput({ value, onChange, label = 'Payee', disabled }: { value: PartyRef; onChange(v: PartyRef): void; label?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="sm:col-span-1">
        <label className="label required" htmlFor={`${id}-n`}>{label}</label>
        <input id={`${id}-n`} className="input" disabled={disabled} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-t`}>TIN</label>
        <input id={`${id}-t`} className="input" disabled={disabled} value={value.tin ?? ''} onChange={(e) => onChange({ ...value, tin: e.target.value })} />
      </div>
      <div>
        <label className="label" htmlFor={`${id}-a`}>Address</label>
        <input id={`${id}-a`} className="input" disabled={disabled} value={value.address ?? ''} onChange={(e) => onChange({ ...value, address: e.target.value })} />
      </div>
    </div>
  );
}

export const emptyParty = (): PartyRef => ({ id: null, name: '', tin: '', address: '' });

export interface LineColumn<T> {
  label: string;
  /** Right-align (money columns). */
  numeric?: boolean;
  required?: boolean;
  className?: string;
  render(row: T, set: (patch: Partial<T>) => void, index: number): ReactNode;
}

/** Editable line items (collection lines, DV charges, liquidation items, payroll entries). */
export function LinesEditor<T>({ rows, onChange, columns, blank, min = 1, max = 150, disabled, footer, addLabel = 'Add line', caption }: {
  rows: T[];
  onChange(rows: T[]): void;
  columns: LineColumn<T>[];
  blank(): T;
  min?: number;
  max?: number;
  disabled?: boolean;
  footer?: ReactNode;
  addLabel?: string;
  caption: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="w-8">#</th>
            {columns.map((c) => (
              <th key={c.label} scope="col" className={`${c.numeric ? 'num' : ''} ${c.required ? 'required' : ''}`}>{c.label}</th>
            ))}
            <th scope="col"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="pt-4 text-xs text-slate-500">{i + 1}</td>
              {columns.map((c) => (
                <td key={c.label} className={c.className}>{c.render(r, (patch) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}</td>
              ))}
              <td>
                {!disabled && rows.length > min && (
                  <button type="button" className="btn-ghost btn-icon text-slate-500 hover:text-red-700" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                    <Icon name="trash" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={columns.length + 2} className="px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {!disabled && rows.length < max ? (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => onChange([...rows, blank()])}>
                    <Icon name="plus" /> {addLabel}
                  </button>
                ) : <span />}
                {footer}
              </div>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Small "label: value" read-only grid for record headers. */
export function InfoGrid({ items, columns = 3 }: { items: Array<[string, ReactNode]>; columns?: 2 | 3 | 4 }) {
  const cls = columns === 2 ? 'sm:grid-cols-2' : columns === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3';
  return (
    <dl className={`grid gap-x-6 gap-y-3 ${cls}`}>
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">{k}</dt>
          <dd className="mt-0.5 text-sm text-slate-900">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
