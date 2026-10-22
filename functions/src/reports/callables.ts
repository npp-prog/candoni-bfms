import { createHash } from 'node:crypto';
import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  REPORT_DEFINITIONS,
  canonicalJson,
  dueDate,
  lastDayOfMonth,
  overallValidation,
  packageDefinitions,
  packageId,
  periodDocId,
  reportBuilder,
  reportDefinition,
  runReport,
  snapshotIdentity,
  submissionId,
  type BarangayId,
  type GeneratedReportRecord,
  type PackageItem,
  type PeriodStatus,
  type ReportBuilder,
  type ReportModel,
  type ReportPackageDoc,
  type ReportParams,
  type ValidationResult,
} from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, writeWorkflowHistory } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';
import type { CallerContext } from '../lib/context';
import { adminDataSource } from './datasource';

/**
 * Phase 12 — Report Center (docs 06 §13, 05 §11–12).
 *  - generateReportSnapshot: server-built, hashed, versioned copy of a report (payload chunked under
 *    generatedReports/{id}/payload because Firestore documents are capped at 1 MiB).
 *  - finalizeReport: FINAL requires no FAILED validator and a LOCKED/CLOSED period; never overwritten.
 *  - generateMonthlyPackage / submitMonthlyPackage / reviewPackageItem: the monthly submission cycle
 *    and the compliance matrix (reportSubmissions cells).
 * Document uploads/attachments are intentionally out of scope.
 */
const ds = adminDataSource(db);
const CHUNK = 800_000;
const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const paramsSchema = z.object({
  barangayId: barangay,
  fiscalYear: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12).optional(),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  semester: z.union([z.literal(1), z.literal(2)]).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  documentId: z.string().max(128).optional(),
  fundId: z.string().max(60).optional(),
  bankAccountId: z.string().max(128).optional(),
  accountCode: z.string().max(20).optional(),
  subsidiaryId: z.string().max(160).optional(),
  itemId: z.string().max(128).optional(),
  variant: z.string().max(40).optional(),
});

function builderOrThrow(code: string): ReportBuilder {
  const b = reportBuilder(code);
  if (!b) throw new HttpsError('not-found', `Report ${code} is not available.`);
  return b;
}

/** Store a snapshot of a built model (new version unless the latest version has the same data). */
async function writeSnapshot(ctx: CallerContext, builder: ReportBuilder, params: ReportParams, model: ReportModel): Promise<{ id: string; version: number; overall: ValidationResult; reused: boolean }> {
  const def = reportDefinition(builder.code)!;
  const id = snapshotIdentity(builder.params, params);
  const { generatedAt: _g, ...stable } = model;
  const dataHash = createHash('sha256').update(canonicalJson(stable)).digest('hex');
  const overall = overallValidation(model.validations);
  const prior = await db
    .collection(COL.generatedReports)
    .where('barangayId', '==', params.barangayId)
    .where('fiscalYear', '==', params.fiscalYear)
    .where('reportCode', '==', builder.code)
    .where('periodKey', '==', id.periodKey)
    .where('filtersKey', '==', id.filtersKey)
    .get();
  const latest = prior.docs.map((d) => ({ id: d.id, ...(d.data() as GeneratedReportRecord) })).sort((a, b) => b.version - a.version)[0];
  if (latest && latest.dataHash === dataHash && latest.status !== 'ARCHIVED' && !latest.staleSource) return { id: latest.id, version: latest.version, overall, reused: true };

  const ref = db.collection(COL.generatedReports).doc();
  const payload = JSON.stringify(model);
  const chunks = Math.max(1, Math.ceil(payload.length / CHUNK));
  const now = Timestamp.now();
  const version = (latest?.version ?? 0) + 1;
  const rec: GeneratedReportRecord = {
    barangayId: params.barangayId,
    fiscalYear: params.fiscalYear,
    reportCode: builder.code,
    title: model.title,
    reportingPeriod: { type: builder.params === 'MONTH' ? 'MONTH' : builder.params === 'QUARTER' ? 'QUARTER' : builder.params === 'AS_OF' ? 'AS_OF' : builder.params === 'RANGE' ? 'RANGE' : 'YEAR', from: id.from, to: id.to, label: model.subtitle[0] ?? '' },
    filters: JSON.parse(id.filtersKey) as Record<string, string>,
    periodKey: id.periodKey,
    filtersKey: id.filtersKey,
    params,
    version,
    status: 'GENERATED',
    templateVersion: def.templateVersion,
    dataHash,
    payloadPath: `${COL.generatedReports}/${ref.id}/payload`,
    payloadChunks: chunks,
    storageFilePath: {},
    validation: model.validations.map((v) => ({ id: v.id, result: v.result, message: v.message })),
    overall,
    isEmpty: model.isEmpty,
    signatories: Object.fromEntries(model.signatories.map((s) => [s.label, { name: s.name, position: s.position }])),
    generatedBy: ctx.uid,
    generatedAt: now,
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    acceptedBy: null,
    acceptedAt: null,
    finalizedBy: null,
    finalizedAt: null,
    sourceDataCutoff: now,
    supersedesReportId: latest?.id ?? null,
    staleSource: false,
  };
  const batch = db.batch();
  for (let i = 0; i < chunks; i++) batch.set(ref.collection('payload').doc(String(i).padStart(3, '0')), { i, data: payload.slice(i * CHUNK, (i + 1) * CHUNK) });
  batch.set(ref, rec);
  await batch.commit();
  await db.runTransaction(async (tx) => {
    const audit = await AuditWriter.begin(tx, ctx, params.barangayId);
    audit.write({ module: COL.generatedReports, recordId: ref.id, action: 'GENERATE', newValue: { reportCode: builder.code, periodKey: id.periodKey, version, dataHash, overall }, source: 'callable:generateReportSnapshot' });
    audit.commit();
  });
  return { id: ref.id, version, overall, reused: false };
}

export const generateReportSnapshot = secureCallable(
  z.object({ code: z.string().min(1).max(40), params: paramsSchema }),
  async ({ code, params }, ctx) => {
    ctx.require('report.generate', params.barangayId);
    const builder = builderOrThrow(code);
    const model = await runReport(builder, ds, params as ReportParams);
    return writeSnapshot(ctx, builder, params as ReportParams, model);
  },
  { timeoutSeconds: 300, memory: '512MiB' },
);

/** Accounting month that must be LOCKED before a snapshot can be FINAL (null = not period-bound). */
function lockMonth(r: GeneratedReportRecord): number | null {
  if (r.periodKey.startsWith('DOC:')) return null;
  return Number(r.reportingPeriod.to.slice(5, 7)) || 12;
}

export const finalizeReport = secureCallable(z.object({ reportId: z.string().min(1).max(128) }), async ({ reportId }, ctx) => {
  const ref = db.collection(COL.generatedReports).doc(reportId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Report snapshot not found.');
    const r = snap.data() as GeneratedReportRecord;
    ctx.require('report.finalize', r.barangayId);
    if (r.status === 'FINAL') return { status: 'FINAL' };
    if (r.status === 'ARCHIVED') throw new BfmsError('INVALID_STATUS', 'An archived version cannot be finalized; generate a new version.');
    if (r.staleSource) throw new BfmsError('INVALID_STATUS', 'The source period was reopened after this version was generated. Generate a new version after relocking.');
    if (r.validation.some((v) => v.result === 'FAILED')) throw new BfmsError('VALIDATION_FAILED', 'A report with FAILED validations cannot be finalized.');
    const m = lockMonth(r);
    if (m) {
      const p = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(r.barangayId, r.fiscalYear, m)));
      const st = p.get('status') as PeriodStatus | undefined;
      if (st !== 'LOCKED' && st !== 'CLOSED') throw new BfmsError('PERIOD_NOT_OPEN', `Lock ${r.fiscalYear}-${String(m).padStart(2, '0')} before finalizing (the period is ${st ?? 'not opened'}).`);
    }
    const others = await tx.get(
      db.collection(COL.generatedReports).where('barangayId', '==', r.barangayId).where('fiscalYear', '==', r.fiscalYear).where('reportCode', '==', r.reportCode).where('periodKey', '==', r.periodKey).where('filtersKey', '==', r.filtersKey).where('status', '==', 'FINAL'),
    );
    const audit = await AuditWriter.begin(tx, ctx, r.barangayId);
    const now = Timestamp.now();
    others.docs.forEach((d) => tx.update(d.ref, { status: 'ARCHIVED', supersededByReportId: reportId }));
    tx.update(ref, { status: 'FINAL', finalizedBy: ctx.uid, finalizedAt: now, supersedesReportId: others.docs[0]?.id ?? r.supersedesReportId });
    audit.write({ module: COL.generatedReports, recordId: reportId, action: 'FINALIZE_REPORT', oldValue: { status: r.status }, newValue: { status: 'FINAL', version: r.version }, source: 'callable:finalizeReport' });
    audit.commit();
    return { status: 'FINAL' };
  });
});

// ------------------------------------------------------------------ monthly package
const pkgInput = z.object({ barangayId: barangay, fiscalYear: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
const NOT_OFFICIAL = ['DRAFT', 'VOID', 'CANCELLED'];

/** Snapshots for one package report: per document (forms), per variant (RAO classes) or once. */
async function packageReports(ctx: CallerContext, builder: ReportBuilder, base: ReportParams): Promise<PackageItem['reports'] | null> {
  const out: PackageItem['reports'] = [];
  if (builder.params === 'DOCUMENT' && builder.document) {
    const d = builder.document;
    const from = `${base.fiscalYear}-${String(base.month).padStart(2, '0')}-01`;
    const to = lastDayOfMonth(base.fiscalYear, base.month!);
    const docs = (await ds.list<Record<string, unknown>>(d.collection, [['barangayId', '==', base.barangayId], ['fiscalYear', '==', base.fiscalYear]]))
      .filter((x) => String(x[d.dateField] ?? '') >= from && String(x[d.dateField] ?? '') <= to && !NOT_OFFICIAL.includes(String(x.status ?? '')))
      .sort((a, b) => String(a[d.dateField]).localeCompare(String(b[d.dateField])));
    for (const doc of docs) {
      const params = { ...base, documentId: doc.id };
      const model = await runReport(builder, ds, params);
      const s = await writeSnapshot(ctx, builder, params, model);
      out.push({ id: s.id, version: s.version, label: String(doc[d.numberField] ?? doc.id), overall: s.overall });
    }
    return out.length ? out : null;
  }
  const select = (builder.extras ?? []).find((e) => e.required && e.kind === 'select');
  const variants = select ? (select.options ?? []).map((o) => ({ key: select.key, value: o.value, label: o.label })) : [null];
  for (const v of variants) {
    const params = v ? { ...base, [v.key]: v.value } : base;
    const model = await runReport(builder, ds, params);
    if (model.isEmpty) continue;
    const s = await writeSnapshot(ctx, builder, params, model);
    out.push({ id: s.id, version: s.version, label: v ? v.label : model.subtitle[0] ?? builder.code, overall: s.overall });
  }
  return out.length ? out : null;
}

const worst = (xs: ValidationResult[]): ValidationResult => (xs.includes('FAILED') ? 'FAILED' : xs.includes('WARNING') ? 'WARNING' : 'PASSED');

export const generateMonthlyPackage = secureCallable(
  pkgInput,
  async (input, ctx) => {
    if (!ctx.can('report.submit', input.barangayId) && !ctx.can('submission.review', input.barangayId)) ctx.require('report.submit', input.barangayId);
    const pkgRef = db.collection(COL.reportPackages).doc(packageId(input.barangayId, input.fiscalYear, input.month));
    const existing = (await pkgRef.get()).data() as ReportPackageDoc | undefined;
    if (existing && (existing.status === 'SUBMITTED' || existing.status === 'RESUBMITTED'))
      throw new BfmsError('INVALID_STATUS', 'The package is with Municipal Accounting for review; it can be regenerated after it is returned.');
    if (existing?.status === 'ACCEPTED') throw new BfmsError('INVALID_STATUS', 'The package was accepted. Reopening the period is required for changes.');
    const base: ReportParams = { barangayId: input.barangayId, fiscalYear: input.fiscalYear, month: input.month };
    const items: PackageItem[] = [];
    for (const def of packageDefinitions(REPORT_DEFINITIONS)) {
      const prev = existing?.items.find((i) => i.reportCode === def.reportCode);
      const due = dueDate(def.deadlineRule, input.fiscalYear, input.month);
      if (prev?.status === 'ACCEPTED') {
        items.push(prev);
        continue;
      }
      const builder = reportBuilder(def.reportCode);
      if (!builder) {
        items.push({ reportCode: def.reportCode, reportName: def.reportName, reports: [], status: 'FAILED', overall: 'FAILED', dueDate: due, remarks: 'Report is not available in this version.' });
        continue;
      }
      const reports = await packageReports(ctx, builder, base);
      if (!reports) {
        items.push({ reportCode: def.reportCode, reportName: def.reportName, reports: [], status: 'NOT_APPLICABLE', overall: null, dueDate: due, remarks: 'No transactions for the month.' });
        continue;
      }
      const overall = worst(reports.map((r) => r.overall));
      items.push({ reportCode: def.reportCode, reportName: def.reportName, reports, status: overall === 'FAILED' ? 'FAILED' : 'GENERATED', overall, dueDate: due, remarks: null });
    }
    const now = Timestamp.now();
    const pkg: ReportPackageDoc = {
      barangayId: input.barangayId,
      fiscalYear: input.fiscalYear,
      month: input.month,
      status: existing?.status === 'RETURNED' ? 'RETURNED' : 'GENERATED',
      items,
      overall: worst(items.filter((i) => i.overall).map((i) => i.overall!)),
      generatedAt: now,
      generatedBy: ctx.uid,
      submittedAt: existing?.submittedAt ?? null,
      submittedBy: existing?.submittedBy ?? null,
      revisionNumber: existing?.revisionNumber ?? 0,
    };
    await pkgRef.set(pkg);
    // The transmittal lists the package, so it is generated from the saved manifest.
    const tb = reportBuilder('TRANSMITTAL');
    if (tb) {
      const model = await runReport(tb, ds, base);
      const s = await writeSnapshot(ctx, tb, base, model);
      pkg.items.push({ reportCode: 'TRANSMITTAL', reportName: 'Transmittal Letter', reports: [{ id: s.id, version: s.version, label: 'Transmittal', overall: s.overall }], status: 'GENERATED', overall: s.overall, dueDate: null, remarks: null });
      await pkgRef.update({ items: pkg.items });
    }
    const batch = db.batch();
    for (const i of pkg.items) {
      if (i.status === 'ACCEPTED') continue;
      batch.set(db.collection(COL.reportSubmissions).doc(submissionId(input.barangayId, input.fiscalYear, input.month, i.reportCode)), {
        barangayId: input.barangayId,
        fiscalYear: input.fiscalYear,
        period: `${input.fiscalYear}-${String(input.month).padStart(2, '0')}`,
        month: input.month,
        reportCode: i.reportCode,
        status: i.status === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : i.status === 'FAILED' ? 'DRAFT' : pkg.status === 'RETURNED' ? 'RETURNED' : 'GENERATED',
        dueDate: i.dueDate ?? '',
        generatedReportId: i.reports[0]?.id ?? null,
        generatedReportIds: i.reports.map((r) => r.id),
        lastActionAt: now,
        lastActionBy: ctx.uid,
      }, { merge: true });
    }
    await batch.commit();
    await db.runTransaction(async (tx) => {
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      audit.write({ module: COL.reportPackages, recordId: pkgRef.id, action: 'GENERATE', newValue: { items: pkg.items.length, overall: pkg.overall }, source: 'callable:generateMonthlyPackage' });
      audit.commit();
    });
    return { packageId: pkgRef.id, overall: pkg.overall, items: pkg.items.map((i) => ({ reportCode: i.reportCode, status: i.status, overall: i.overall, versions: i.reports.length })) };
  },
  { timeoutSeconds: 540, memory: '1GiB' },
);

export const submitMonthlyPackage = secureCallable(pkgInput, async (input, ctx) => {
  ctx.require('report.submit', input.barangayId);
  const pkgRef = db.collection(COL.reportPackages).doc(packageId(input.barangayId, input.fiscalYear, input.month));
  const periodRef = db.collection(COL.accountingPeriods).doc(periodDocId(input.barangayId, input.fiscalYear, input.month));
  return db.runTransaction(async (tx) => {
    const [snap, period] = await Promise.all([tx.get(pkgRef), tx.get(periodRef)]);
    const pkg = snap.data() as ReportPackageDoc | undefined;
    if (!pkg) throw new BfmsError('VALIDATION_FAILED', 'Generate the monthly package first.');
    if (!['GENERATED', 'RETURNED'].includes(pkg.status)) throw new BfmsError('INVALID_STATUS', `The package is already ${pkg.status}.`);
    const failed = pkg.items.filter((i) => i.status === 'FAILED' || i.status === 'RETURNED');
    if (failed.length) throw new BfmsError('VALIDATION_FAILED', `Fix and regenerate before submitting: ${failed.map((i) => i.reportCode).join(', ')}.`, { items: failed.map((i) => i.reportCode) });
    const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
    const now = Timestamp.now();
    const to = pkg.status === 'RETURNED' ? 'RESUBMITTED' : 'SUBMITTED';
    tx.update(pkgRef, { status: to, submittedAt: now, submittedBy: ctx.uid, revisionNumber: pkg.revisionNumber + (to === 'RESUBMITTED' ? 1 : 0) });
    for (const i of pkg.items) {
      if (i.status === 'NOT_APPLICABLE' || i.status === 'ACCEPTED') continue;
      tx.set(db.collection(COL.reportSubmissions).doc(submissionId(input.barangayId, input.fiscalYear, input.month, i.reportCode)), { status: to, lastActionAt: now, lastActionBy: ctx.uid, submittedAt: now }, { merge: true });
      for (const r of i.reports) tx.update(db.collection(COL.generatedReports).doc(r.id), { status: 'SUBMITTED', submittedBy: ctx.uid, submittedAt: now });
    }
    // Month-end submission received → period REVIEW (docs 05 §11).
    if (period.exists && period.get('status') === 'OPEN') {
      tx.update(periodRef, { status: 'REVIEW', history: [...((period.get('history') as unknown[]) ?? []), { from: 'OPEN', to: 'REVIEW', by: ctx.uid, at: now, reason: 'Monthly package submitted' }] });
      writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: COL.accountingPeriods, recordId: periodRef.id, fromStatus: 'OPEN', toStatus: 'REVIEW', remarks: 'Monthly package submitted' });
    }
    writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: COL.reportPackages, recordId: pkgRef.id, fromStatus: pkg.status, toStatus: to });
    audit.write({ module: COL.reportPackages, recordId: pkgRef.id, action: 'SUBMIT_PACKAGE', oldValue: { status: pkg.status }, newValue: { status: to }, source: 'callable:submitMonthlyPackage' });
    audit.commit();
    return { status: to };
  });
});

export const reviewPackageItem = secureCallable(
  pkgInput.extend({ reportCode: z.string().min(1).max(40), decision: z.enum(['ACCEPT', 'RETURN']), remarks: z.string().max(1000).nullish() }),
  async (input, ctx) => {
    ctx.require(input.decision === 'ACCEPT' ? 'submission.accept' : 'submission.review', input.barangayId);
    if (input.decision === 'RETURN' && (input.remarks ?? '').trim().length < 5) throw new HttpsError('invalid-argument', 'State what must be corrected (at least 5 characters).');
    const pkgRef = db.collection(COL.reportPackages).doc(packageId(input.barangayId, input.fiscalYear, input.month));
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(pkgRef);
      const pkg = snap.data() as ReportPackageDoc | undefined;
      if (!pkg) throw new HttpsError('not-found', 'Package not found.');
      if (pkg.status !== 'SUBMITTED' && pkg.status !== 'RESUBMITTED') throw new BfmsError('INVALID_STATUS', `The package is ${pkg.status}; only submitted packages are reviewed.`);
      const idx = pkg.items.findIndex((i) => i.reportCode === input.reportCode);
      if (idx < 0) throw new HttpsError('not-found', `${input.reportCode} is not in this package.`);
      const item = pkg.items[idx]!;
      if (item.status === 'NOT_APPLICABLE') throw new BfmsError('INVALID_STATUS', 'Not-applicable items need no review.');
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      const items = pkg.items.map((i, k) => (k === idx ? { ...i, status: input.decision === 'ACCEPT' ? ('ACCEPTED' as const) : ('RETURNED' as const), remarks: input.remarks?.trim() || null } : i));
      const open = items.filter((i) => i.status === 'GENERATED');
      const status: ReportPackageDoc['status'] = open.length ? pkg.status : items.some((i) => i.status === 'RETURNED') ? 'RETURNED' : 'ACCEPTED';
      tx.update(pkgRef, { items, status });
      tx.set(db.collection(COL.reportSubmissions).doc(submissionId(input.barangayId, input.fiscalYear, input.month, input.reportCode)), { status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'RETURNED', lastActionAt: now, lastActionBy: ctx.uid, remarks: input.remarks ?? null }, { merge: true });
      for (const r of item.reports)
        tx.update(db.collection(COL.generatedReports).doc(r.id), input.decision === 'ACCEPT' ? { status: 'ACCEPTED', acceptedBy: ctx.uid, acceptedAt: now, reviewedBy: ctx.uid, reviewedAt: now } : { status: 'RETURNED', reviewedBy: ctx.uid, reviewedAt: now });
      writeWorkflowHistory(tx, ctx, { barangayId: input.barangayId, module: COL.reportPackages, recordId: `${pkgRef.id}_${input.reportCode}`, fromStatus: item.status, toStatus: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'RETURNED', remarks: input.remarks ?? null });
      audit.write({ module: COL.reportSubmissions, recordId: submissionId(input.barangayId, input.fiscalYear, input.month, input.reportCode), action: input.decision === 'ACCEPT' ? 'ACCEPT' : 'RETURN', newValue: { package: status }, reason: input.remarks ?? null, source: 'callable:reviewPackageItem' });
      audit.commit();
      return { itemStatus: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'RETURNED', packageStatus: status };
    });
  },
);
