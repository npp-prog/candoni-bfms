import { REPORT_DEFINITIONS } from '../../constants/reportDefinitions';
import { manilaToday } from '../../accounting/periods';
import type { ReportSubmissionDoc } from '../../types/reporting';
import { dueDate, effectiveStatus, packageDefinitions, packageId, submissionId, type ReportPackageDoc } from '../compliance';
import type { ReportBuilder } from '../context';
import { col, longDate, monthLabel, row, table, type ReportRow } from '../model';

/** Phase 12 — Transmittal Letter accompanying the monthly submission package. */
const TRANSMITTAL: ReportBuilder = {
  code: 'TRANSMITTAL',
  params: 'MONTH',
  async build(ctx) {
    const { barangayId, fiscalYear } = ctx.params;
    const month = ctx.params.month ?? 1;
    const pkg = await ctx.ds.get<ReportPackageDoc>('reportPackages', packageId(barangayId, fiscalYear, month));
    const ma = ctx.sign('Received by', 'MUNICIPAL_ACCOUNTANT');
    const items = (pkg?.items ?? []).filter((i) => i.status !== 'NOT_APPLICABLE');
    const na = (pkg?.items ?? []).filter((i) => i.status === 'NOT_APPLICABLE');
    const rows: ReportRow[] = items.map((i, n) =>
      row({ no: n + 1, code: i.reportCode, name: i.reportName, versions: i.reports.map((r) => `${r.label} v${r.version}`).join('; '), remarks: i.overall === 'WARNING' ? 'With warnings' : '' }),
    );
    const date = pkg?.submittedAt ? new Date(pkg.submittedAt.seconds * 1000).toISOString().slice(0, 10) : manilaToday();
    return {
      subtitle: [longDate(date)],
      meta: [],
      sections: [
        {
          kind: 'text',
          paragraphs: [
            `${ma.name || 'THE MUNICIPAL ACCOUNTANT'}`,
            'Municipal Accountant, Municipality of Candoni',
            'Sir/Madam:',
            `We respectfully submit the following reports and documents of Barangay ${ctx.barangayName} for the month of ${monthLabel(fiscalYear, month)}:`,
          ],
        },
        table([col('no', 'No.', 'number'), col('code', 'Code', 'code'), col('name', 'Report / document', 'text', { width: 3 }), col('versions', 'Version', 'text', { width: 2 }), col('remarks', 'Remarks', 'text')], rows, {
          emptyText: 'Generate the monthly package first (Monthly Submission page).',
        }),
        ...(na.length
          ? [{ kind: 'text' as const, title: 'Not applicable this month (no transactions)', paragraphs: [na.map((i) => `${i.reportCode} — ${i.reportName}`).join('; ')] }]
          : []),
        { kind: 'text', paragraphs: ['Very truly yours,'] },
      ],
      signatories: [ctx.sign('Submitted by', 'BARANGAY_TREASURER'), ctx.sign('Noted by', 'PUNONG_BARANGAY'), { label: 'Received by', name: '', position: 'Municipal Accounting Office' }],
      validations: [],
      isEmpty: !pkg,
    };
  },
};

/** Phase 12 — Compliance Report: status of each required report for the month, with due dates. */
const COMPLIANCE: ReportBuilder = {
  code: 'COMPLIANCE',
  params: 'MONTH',
  async build(ctx) {
    const { barangayId, fiscalYear } = ctx.params;
    const month = ctx.params.month ?? 1;
    const cells = await ctx.ds.list<ReportSubmissionDoc & { submittedAt?: { seconds: number } | null; generatedReportIds?: string[] }>('reportSubmissions', [
      ['barangayId', '==', barangayId],
      ['fiscalYear', '==', fiscalYear],
    ]);
    const byId = new Map(cells.map((c) => [c.id, c]));
    const today = manilaToday();
    const rows = packageDefinitions(REPORT_DEFINITIONS).map((d) => {
      const c = byId.get(submissionId(barangayId, fiscalYear, month, d.reportCode));
      const due = dueDate(d.deadlineRule, fiscalYear, month);
      const status = effectiveStatus(c?.status, due, today);
      return row({ code: d.reportCode, name: d.reportName, office: d.responsibleOffice.replace(/_/g, ' ').toLowerCase(), due: due ?? '', status: status.replace(/_/g, ' '), action: c?.lastActionAt ? new Date(c.lastActionAt.seconds * 1000).toISOString().slice(0, 10) : '' });
    });
    const counts = rows.reduce<Record<string, number>>((t, r) => ({ ...t, [String(r.cells.status)]: (t[String(r.cells.status)] ?? 0) + 1 }), {});
    return {
      subtitle: [`For the month of ${monthLabel(fiscalYear, month)}`],
      meta: Object.entries(counts).map(([k, v]) => ({ label: k, value: String(v) })),
      sections: [table([col('code', 'Code', 'code'), col('name', 'Report', 'text', { width: 3 }), col('office', 'Responsible office', 'text', { width: 2 }), col('due', 'Due date', 'date'), col('status', 'Status', 'text'), col('action', 'Last action', 'date')], rows)],
      signatories: [ctx.sign('Prepared by', 'MUNICIPAL_ACCOUNTANT')],
      validations: [],
      isEmpty: false,
    };
  },
};

export const COMPLIANCE_REPORTS: ReportBuilder[] = [TRANSMITTAL, COMPLIANCE];
