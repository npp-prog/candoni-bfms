import { useId, type ReactNode } from 'react';
import { Money } from '../../components/ui';

/** Row of KPI cards (amounts in centavos render as pesos unless `money: false`). */
export function Kpis({ items }: { items: Array<{ label: string; value: number; money?: boolean; tone?: 'warn' }> }) {
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((k) => {
        const warn = k.tone === 'warn' && k.value > 0;
        return (
          <div key={k.label} className={`card p-4 ${warn ? 'border-orange-300 bg-orange-50' : ''}`}>
            <div className="kpi-label">{k.label}</div>
            <div className={`kpi-value text-xl ${warn ? 'text-orange-800' : ''}`}>{k.money === false ? k.value : <>₱<Money value={k.value} dashZero={false} /></>}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Read-only summary line inside editors (label left, amount right). */
export function SumLine({ label, value, strong, danger }: { label: ReactNode; value: number; strong?: boolean; danger?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-0.5 text-sm ${strong ? 'font-semibold' : ''} ${danger ? 'text-red-700' : 'text-slate-800'}`}>
      <span>{label}</span>
      <span className="tabular-nums">₱<Money value={value} dashZero={false} /></span>
    </div>
  );
}

/** Grid cell with a screen-reader label wired to its control (line editors have no visible labels per row). */
export function Cell({ label, children }: { label: string; children(id: string): ReactNode }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      {children(id)}
    </>
  );
}
