import { formatPesos, type Centavos, type FinancialSummaryDoc } from '@bfms/shared';
import { useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Categorical order is fixed: collections = navy, disbursements = gold (validated for CVD separation; gold is
// below 3:1 on white, so the table view below is the required relief).
const SERIES = [
  { key: 'collections', label: 'Collections', color: '#2b5189' },
  { key: 'disbursements', label: 'Disbursements', color: '#c9a227' },
] as const;

const W = 720;
const H = 240;
const PAD = { top: 12, right: 8, bottom: 24, left: 64 };

/** Compact peso label for the axis: ₱1.2M, ₱350K. */
function short(c: number): string {
  const p = c / 100;
  if (Math.abs(p) >= 1e6) return `₱${(p / 1e6).toFixed(1)}M`;
  if (Math.abs(p) >= 1e3) return `₱${Math.round(p / 1e3)}K`;
  return `₱${Math.round(p)}`;
}

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= v)!;
}

export function MonthlyFlowChart({ monthly }: { monthly: FinancialSummaryDoc['monthly'] }) {
  const [hover, setHover] = useState<{ m: number; s: number } | null>(null);
  const [table, setTable] = useState(false);
  const byMonth = MONTHS.map((_, i) => monthly.find((r) => r.month === i + 1));
  const max = niceMax(Math.max(0, ...byMonth.flatMap((r) => (r ? [r.collections, r.disbursements] : []))));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / 12;
  const barW = Math.min(18, (band - 10) / 2);
  const y = (v: number) => PAD.top + plotH - (Math.max(v, 0) / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <ul className="flex gap-4 text-xs text-slate-700" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
        <button type="button" className="btn-ghost btn-sm text-xs" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      {table ? (
        <div className="overflow-x-auto">
          <table className="table-base">
            <caption className="sr-only">Collections and disbursements by month, in pesos</caption>
            <thead><tr><th>Month</th><th className="num">Collections</th><th className="num">Disbursements</th><th className="num">Net</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {byMonth.map((r, i) => (
                <tr key={i}>
                  <td>{MONTHS[i]}</td>
                  <td className="num">{r ? formatPesos(r.collections) : '—'}</td>
                  <td className="num">{r ? formatPesos(r.disbursements) : '—'}</td>
                  <td className="num">{r ? formatPesos((r.collections - r.disbursements) as Centavos) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // Below ~560px the labels would shrink past legibility, so the plot scrolls instead of scaling.
        <div className="overflow-x-auto">
          <div className="relative min-w-[560px] pt-14">
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Bar chart of monthly collections and disbursements. Use “Show as table” for the figures.">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
                  <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="#475569">{short(t)}</text>
                </g>
              ))}
              {byMonth.map((r, m) => {
                const x0 = PAD.left + m * band + band / 2 - barW - 1;
                return (
                  <g key={m}>
                    {SERIES.map((s, si) => {
                      const v = r ? r[s.key] : 0;
                      const top = y(v);
                      const h = Math.max(PAD.top + plotH - top, 0);
                      const x = x0 + si * (barW + 2);
                      const active = hover?.m === m && hover.s === si;
                      return (
                        <g key={s.key}>
                          {h > 0 && <path d={roundedTop(x, top, barW, h, Math.min(4, h))} fill={s.color} opacity={hover && !active ? 0.55 : 1} />}
                          {/* Hit target larger than the mark. */}
                          <rect
                            x={x - 1}
                            y={PAD.top}
                            width={barW + 2}
                            height={plotH}
                            fill="transparent"
                            tabIndex={r ? 0 : -1}
                            aria-label={`${MONTHS[m]} ${s.label}: ${formatPesos(v as Centavos, { symbol: true })}`}
                            onMouseEnter={() => setHover({ m, s: si })}
                            onMouseLeave={() => setHover(null)}
                            onFocus={() => setHover({ m, s: si })}
                            onBlur={() => setHover(null)}
                          />
                        </g>
                      );
                    })}
                    <text x={PAD.left + m * band + band / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#475569">{MONTHS[m]}</text>
                  </g>
                );
              })}
              <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#94a3b8" strokeWidth={1} />
            </svg>
            {hover && (
              <div
                className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
                style={{ left: `${((PAD.left + hover.m * band + band / 2) / W) * 100}%` }}
              >
                <div className="font-semibold text-slate-800">{MONTHS[hover.m]}</div>
                {SERIES.map((s, si) => (
                  <div key={s.key} className={`flex items-center gap-1.5 tabular-nums ${si === hover.s ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>
                    <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                    {s.label}: {formatPesos((byMonth[hover.m]?.[s.key] ?? 0) as Centavos, { symbol: true })}
                  </div>
                ))}
              </div>
            )}
        </div>
        </div>
      )}
    </div>
  );
}

/** Bar path with rounded top corners, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
