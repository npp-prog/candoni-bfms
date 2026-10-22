import type { ReportColumn, ReportModel, ReportRow, ReportSection, TableSection } from '@bfms/shared';
import { formatCell, isNumericType } from './format';

/** Merge consecutive columns that share a `group` into one upper header cell. */
function groupHeader(columns: ReportColumn[]) {
  const out: Array<{ label: string; span: number }> = [];
  for (const c of columns) {
    const label = c.group ?? '';
    const last = out[out.length - 1];
    if (last && last.label === label && label) last.span++;
    else out.push({ label, span: 1 });
  }
  return out.some((g) => g.label) ? out : null;
}

const ROW_CLASS: Record<NonNullable<ReportRow['style']>, string> = {
  normal: '',
  heading: 'rpt-heading',
  subheading: 'rpt-subheading',
  subtotal: 'rpt-subtotal',
  total: 'rpt-total',
  grandtotal: 'rpt-grandtotal',
  note: 'rpt-note',
};

function Table({ s }: { s: TableSection }) {
  const groups = groupHeader(s.columns);
  // Statements indent their line-item text (the first text column).
  const indentCol = s.columns.findIndex((c) => c.type === 'text');
  return (
    <div className="rpt-section">
      {s.title && <h3 className="rpt-section-title">{s.title}</h3>}
      <div className="overflow-x-auto print:overflow-visible">
        <table className="rpt-table">
          <thead>
            {groups && (
              <tr>
                {groups.map((g, i) => (
                  <th key={i} colSpan={g.span} className={g.label ? 'rpt-group' : 'rpt-group-empty'} scope="colgroup">{g.label}</th>
                ))}
              </tr>
            )}
            <tr>
              {s.columns.map((c) => (
                <th key={c.key} scope="col" className={isNumericType(c.type) ? 'rpt-num' : ''} style={c.width ? { width: `${c.width * 8}%` } : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.length === 0 ? (
              <tr>
                <td colSpan={s.columns.length} className="rpt-empty">{s.emptyText ?? 'No records for this period.'}</td>
              </tr>
            ) : (
              s.rows.map((r, i) => (
                <tr key={i} className={ROW_CLASS[r.style ?? 'normal']}>
                  {s.columns.map((c, ci) => (
                    <td key={c.key} className={`${isNumericType(c.type) ? 'rpt-num' : ''} ${c.type === 'code' ? 'rpt-code' : ''}`} style={ci === indentCol && r.indent ? { paddingLeft: `${r.indent * 1.25 + 0.4}rem` } : undefined}>
                      {formatCell(r.cells[c.key] ?? null, c.type)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({ s }: { s: ReportSection }) {
  switch (s.kind) {
    case 'table':
      return <Table s={s} />;
    case 'fields':
      return (
        <div className="rpt-section">
          {s.title && <h3 className="rpt-section-title">{s.title}</h3>}
          <dl className="rpt-fields" style={{ gridTemplateColumns: `repeat(${s.columns ?? 2}, minmax(0, 1fr))` }}>
            {s.fields.map((f, i) => (
              <div key={i} style={f.span ? { gridColumn: `span ${f.span} / span ${f.span}` } : undefined}>
                <dt>{f.label}</dt>
                <dd className={f.type && isNumericType(f.type) ? 'tabular-nums' : ''}>{formatCell(f.value, f.type ?? 'text') || ' '}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case 'text':
      return (
        <div className="rpt-section rpt-text">
          {s.title && <h3 className="rpt-section-title">{s.title}</h3>}
          {s.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      );
    case 'certifications':
      return (
        <div className="rpt-section rpt-certs">
          {s.boxes.map((b, i) => (
            <div key={i} className="rpt-cert">
              <div className="rpt-cert-label">{b.label}</div>
              {b.text && <p className="rpt-cert-text">{b.text}</p>}
              <div className="rpt-sign">
                <div className="rpt-sign-name">{b.name || ' '}</div>
                <div className="rpt-sign-pos">{b.position}</div>
                {b.date !== undefined && <div className="rpt-sign-date">Date: {b.date ? formatCell(b.date, 'date') : '__________'}</div>}
              </div>
            </div>
          ))}
        </div>
      );
  }
}

/** The printable page. Validations are shown on screen only (see ReportViewerPage). */
export function ReportDocument({ model }: { model: ReportModel }) {
  return (
    <article className={`rpt rpt-${model.paper.orientation.toLowerCase()}`} aria-label={model.title}>
      <header className="rpt-header">
        {model.agencyHeader.map((l, i) => (
          <div key={i} className={i === model.agencyHeader.length - 1 ? 'rpt-agency-main' : 'rpt-agency'}>{l}</div>
        ))}
        <h2 className="rpt-title">{model.title}</h2>
        {model.subtitle.map((l, i) => <div key={i} className="rpt-subtitle">{l}</div>)}
      </header>
      {model.meta.length > 0 && (
        <dl className="rpt-meta">
          {model.meta.map((m, i) => (
            <div key={i}>
              <dt>{m.label}:</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {model.sections.map((s, i) => <Section key={i} s={s} />)}
      {model.notes && model.notes.length > 0 && (
        <ul className="rpt-notes">
          {model.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      {model.signatories.length > 0 && (
        <div className="rpt-signatories" style={{ gridTemplateColumns: `repeat(${Math.min(model.signatories.length, 3)}, minmax(0, 1fr))` }}>
          {model.signatories.map((s, i) => (
            <div key={i} className="rpt-sign">
              <div className="rpt-sign-label">{s.label}:</div>
              <div className="rpt-sign-name">{s.name || ' '}</div>
              <div className="rpt-sign-pos">{s.position}</div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
