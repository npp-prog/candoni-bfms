import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { EmptyState, TableSkeleton } from './ui';

/** Route-based module tabs (each tab is a nested route), e.g. Budget → Appropriations | Obligations. */
export function ModuleTabs({ tabs, label }: { tabs: Array<{ to: string; label: string; end?: boolean }>; label: string }) {
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `-mb-px min-h-[2.5rem] border-b-2 px-4 py-2 text-sm transition-colors ${isActive ? 'border-gold-500 font-semibold text-navy-800' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-navy-700'}`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export interface RegisterColumn<T> {
  label: string;
  numeric?: boolean;
  className?: string;
  render(row: T): ReactNode;
}

/**
 * Register (list) of records. The first column renders as a button that opens the record, so the
 * list works by keyboard and screen reader; clicking anywhere on the row is a mouse convenience.
 */
export function RegisterTable<T extends { id: string }>({ rows, columns, onOpen, loading, empty, caption, toolbar, footer }: {
  rows: T[];
  columns: RegisterColumn<T>[];
  onOpen?(row: T): void;
  loading?: boolean;
  empty: ReactNode;
  caption: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="card">
      {toolbar && <div className="card-header justify-start">{toolbar}</div>}
      {loading ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        <div className="p-4">{typeof empty === 'string' ? <EmptyState title={empty} /> : empty}</div>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="table-base table-hover">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label} scope="col" className={c.numeric ? 'num' : ''}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className={onOpen ? 'cursor-pointer' : ''} onClick={onOpen ? () => onOpen(r) : undefined}>
                  {columns.map((c, i) => (
                    <td key={c.label} className={`${c.numeric ? 'num' : ''} ${c.className ?? ''}`}>
                      {i === 0 && onOpen ? (
                        <button type="button" className="text-left font-medium text-navy-800 hover:underline focus-visible:underline" onClick={(e) => { e.stopPropagation(); onOpen(r); }}>
                          {c.render(r)}
                        </button>
                      ) : (
                        c.render(r)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footer}
    </div>
  );
}

/** Status filter select used in register toolbars. */
export function StatusFilter({ value, onChange, options, id = 'status-filter' }: { value: string; onChange(v: string): void; options: string[]; id?: string }) {
  return (
    <>
      <label className="label mb-0" htmlFor={id}>Status</label>
      <select id={id} className="input max-w-[12rem]" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All statuses</option>
        {options.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
      </select>
    </>
  );
}
