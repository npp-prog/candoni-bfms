import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  assertIsoDate,
  assertPeriodAllowsPosting,
  balanceDeltas,
  bookForLines,
  periodDocId,
  periodKey,
  uniqueKeyId,
  validateJournalAccounts,
  validateJournalBalance,
  type BalanceDelta,
  type BarangayId,
  type Centavos,
  type ChartOfAccountDoc,
  type JournalEntryDoc,
  type JournalLineDoc,
  type JournalLineInput,
  type PeriodStatus,
  type SubsidiaryAccountDoc,
} from '@bfms/shared';
import type { DocumentReference, Query, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import {
  IMPORT_KEY_RE,
  IMPORT_LIMITS,
  IMPORT_PARTS,
  type ImportPart,
  type ImportStatus,
} from '@bfms/shared';
import { AuditWriter, writeWorkflowHistory } from '../../audit/auditWriter';
import { db, FieldValue, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';
import type { CallerContext } from '../../lib/context';
import { SequenceAllocator } from '../../numbering/sequences';
import { subsidiaryId } from '../../setup/masters';

/**
 * Legacy workbook import (Municipal Accounting's Google Sheets books → BFMS).
 *
 * The browser parses the workbook (shared/src/accounting/workbookImport.ts) and sends the
 * normalised parts in batches. Design decisions:
 *
 *  - ONE ACTOR. Every mutating import callable requires `import.approve` AND `jev.post` (the
 *    Municipal Accountant). The legacy entries were prepared and reviewed in the workbook already;
 *    the import is a migration of those books, not new transactions, so the normal
 *    preparer ≠ poster rule does not apply. Instead the JEVs are created and posted in one
 *    dedicated server path that keeps every other posting control: balance, Chart of Accounts /
 *    subsidiary validation, period OPEN, fiscal-year check, JEV numbers allocated in date order,
 *    balance aggregates, workflow history per JEV and a hash-chained IMPORT_COMMIT audit record
 *    per transaction. Staff (`import.manage`) can run the preview and `importStatus`.
 *  - RE-IMPORT SAFETY. Posted books are immutable, so nothing is ever replaced or deleted:
 *    the journal is refused when the year already has IMPORT entries or other posted regular
 *    entries (JEV numbers would no longer be chronological); the opening is refused when
 *    period 00 has posted entries; prior years / CA list / PPE schedule are refused when present.
 *    A per-year registry document (importBatches/{bid}_{fy}) serialises imports.
 *  - IDEMPOTENT BATCHES. JEV ids are deterministic (`IMP-{importId}-{key}`), so a retried batch
 *    skips what was already posted. A begun-but-unfinished import is resumed by re-running the
 *    same workbook (same fingerprint) as the same user.
 *  - Invalid entries (unbalanced, unknown account …) are REJECTED individually and reported;
 *    the rest of the batch posts.
 */

const barangay = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);
const year = z.number().int().min(2000).max(2100);
const accountCode = z.string().regex(/^\d-\d{2}-\d{2}-\d{3}$/);
const slCode = z.string().regex(/^[A-Z0-9-]{2,20}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const centavos = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ref = z.string().trim().max(60).nullable();
const importIdSchema = z.string().regex(/^[A-Za-z0-9]{10,40}$/);

const SL_TYPES = ['ACCOUNTABLE_OFFICER', 'EMPLOYEE', 'SUPPLIER', 'BANK', 'RECEIVABLE', 'PAYABLE', 'BIR', 'CASH_ADVANCE', 'SPECIAL_TRUST_FUND', 'GOVERNMENT_AGENCY', 'OTHER'] as const;
const TX_TYPES = ['DISBURSEMENT', 'COLLECTION', 'DEPOSIT', 'LIQUIDATION', 'OTHERS', 'OPENING'] as const;

const entrySchema = z.object({
  key: z.string().regex(IMPORT_KEY_RE),
  date: isoDate,
  transactionType: z.enum(TX_TYPES),
  primaryReference: ref,
  secondaryReference: ref,
  tertiaryReference: ref,
  payeeName: z.string().trim().max(200).nullable(),
  particulars: z.string().trim().min(3).max(2000),
  lines: z.array(z.object({ accountCode, subsidiaryCode: slCode.nullable(), debit: centavos, credit: centavos })).min(1).max(150),
  legacyRows: z.array(z.number().int().positive()).max(200).default([]),
});
type EntryInput = z.infer<typeof entrySchema>;

const registryId = (bid: string, fy: number) => `${bid}_${fy}`;
const jevDocId = (importId: string, key: string) => `IMP-${importId}-${key}`;
const WRITE_BUDGET = 490;

interface BatchDoc {
  kind: 'BATCH';
  barangayId: BarangayId;
  fiscalYear: number;
  status: 'IN_PROGRESS' | 'COMPLETED';
  parts: ImportPart[];
  fingerprint: string;
  sourceTitle: string;
  lastJevDate: string | null;
  openingPosted: boolean;
  createdBy: string;
  createdByName: string;
}

function requireImporter(ctx: CallerContext, bid: BarangayId) {
  ctx.require('import.approve', bid);
  ctx.require('jev.post', bid);
}

// ---------------------------------------------------------------------------------------------
// State of a barangay-year (shared by importStatus and the importBegin guard)

async function readState(tx: Transaction | null, bid: BarangayId, fy: number) {
  const doc = (r: DocumentReference) => (tx ? tx.get(r) : r.get());
  const query = (q: Query) => (tx ? tx.get(q) : q.get());
  const je = db.collection(COL.journalEntries).where('barangayId', '==', bid).where('fiscalYear', '==', fy);
  const [bfy, registry, lb1, lb2, ppe] = await Promise.all([
    doc(db.collection(COL.barangayFiscalYears).doc(`${bid}_${fy}`)),
    doc(db.collection(COL.importBatches).doc(registryId(bid, fy))),
    doc(db.collection(COL.legacyBalances).doc(`${bid}_${fy - 1}`)),
    doc(db.collection(COL.legacyBalances).doc(`${bid}_${fy - 2}`)),
    doc(db.collection(COL.ppeSchedules).doc(`${bid}_${fy}`)),
  ]);
  // Equality-only queries (no composite index needed); POSTED and REVERSED read separately.
  const [importReg, posted, reversed, openPosted, openReversed, ca] = await Promise.all([
    query(je.where('sourceModule', '==', 'IMPORT').where('entryType', '==', 'REGULAR').limit(1)),
    query(je.where('entryType', '==', 'REGULAR').where('status', '==', 'POSTED').limit(20)),
    query(je.where('entryType', '==', 'REGULAR').where('status', '==', 'REVERSED').limit(20)),
    query(je.where('accountingPeriod', '==', periodKey(fy, 0)).where('status', '==', 'POSTED').limit(1)),
    query(je.where('accountingPeriod', '==', periodKey(fy, 0)).where('status', '==', 'REVERSED').limit(1)),
    query(db.collection(COL.legacyCashAdvances).where('barangayId', '==', bid).where('fiscalYear', '==', fy).limit(1)),
  ]);
  const postedRegular = [...posted.docs, ...reversed.docs];
  const state = {
    fiscalYearOpen: bfy.exists && bfy.get('status') === 'OPEN',
    registry,
    openingPosted: !openPosted.empty || !openReversed.empty,
    journalImported: !importReg.empty,
    otherPostedEntries: postedRegular.some((d) => d.get('sourceModule') !== 'IMPORT'),
    legacyBalanceYears: [lb1, lb2].filter((d) => d.exists).map((d) => d.get('fiscalYear') as number),
    cashAdvancesImported: !ca.empty,
    ppeScheduleExists: ppe.exists,
  };
  const blocked: Partial<Record<ImportPart, string>> = {};
  if (!state.fiscalYearOpen) for (const p of IMPORT_PARTS) blocked[p] = `Fiscal year ${fy} is not open for ${bid}; open it in Calendar first.`;
  else {
    if (state.openingPosted) blocked.OPENING = `Period ${fy}-00 already has posted opening entries; opening balances cannot be imported again.`;
    if (state.journalImported) blocked.JOURNAL = `The ${fy} journal of ${bid} was already imported. Posted entries are never replaced: correct differences with adjusting entries.`;
    else if (state.otherPostedEntries) blocked.JOURNAL = `${bid} ${fy} already has posted journal entries encoded in BFMS; importing the legacy journal now would put JEV numbers out of date order.`;
    if (state.legacyBalanceYears.length >= 2) blocked.PRIOR_YEARS = `Prior-year balances ${state.legacyBalanceYears.join(', ')} were already imported.`;
    if (state.cashAdvancesImported) blocked.CASH_ADVANCES = `Legacy cash advances of ${bid} ${fy} were already imported.`;
    if (state.ppeScheduleExists) blocked.PPE = `A ${fy} PPE schedule already exists; edit it in Schedules.`;
  }
  return { ...state, blocked };
}

export const importStatus = secureCallable(z.object({ barangayId: barangay, fiscalYear: year }), async ({ barangayId: bid, fiscalYear: fy }, ctx) => {
  ctx.require('import.manage', bid);
  const st = await readState(null, bid, fy);
  const [banks, subs] = await Promise.all([
    db.collection(COL.bankAccounts).where('barangayId', '==', bid).get(),
    db.collection(COL.subsidiaryAccounts).where('barangayId', '==', bid).select('accountCode', 'subsidiaryCode').get(),
  ]);
  let inProgress: ImportStatus['inProgress'] = null;
  const active = st.registry.get('activeImportId') as string | null | undefined;
  if (active) {
    const b = await db.collection(COL.importBatches).doc(active).get();
    if (b.exists && b.get('status') === 'IN_PROGRESS')
      inProgress = { importId: active, fingerprint: b.get('fingerprint') as string, createdBy: b.get('createdBy') as string, createdByName: b.get('createdByName') as string, parts: b.get('parts') as ImportPart[] };
  }
  const out: ImportStatus = {
    barangayId: bid,
    fiscalYear: fy,
    fiscalYearOpen: st.fiscalYearOpen,
    openingPosted: st.openingPosted,
    journalImported: st.journalImported,
    otherPostedEntries: st.otherPostedEntries,
    legacyBalanceYears: st.legacyBalanceYears,
    cashAdvancesImported: st.cashAdvancesImported,
    ppeScheduleExists: st.ppeScheduleExists,
    bankAccounts: banks.docs.filter((d) => d.get('active') !== false).map((d) => ({ id: d.id, label: `${String(d.get('bankName'))} ${String(d.get('accountNumber'))}`, subsidiaryCode: (d.get('subsidiaryCode') as string | undefined) ?? null })),
    existingSubsidiaries: subs.docs.map((d) => `${String(d.get('accountCode'))}|${String(d.get('subsidiaryCode'))}`),
    inProgress,
    blocked: st.blocked,
  };
  return out;
});

// ---------------------------------------------------------------------------------------------

export const importBegin = secureCallable(
  z.object({
    barangayId: barangay,
    fiscalYear: year,
    parts: z.array(z.enum(IMPORT_PARTS)).min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{4,64}$/),
    sourceTitle: z.string().trim().max(200).default(''),
    counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }),
  async (input, ctx) => {
    const { barangayId: bid, fiscalYear: fy } = input;
    requireImporter(ctx, bid);
    const regRef = db.collection(COL.importBatches).doc(registryId(bid, fy));
    const batchRef = db.collection(COL.importBatches).doc();
    return db.runTransaction(async (tx) => {
      const st = await readState(tx, bid, fy);
      const active = st.registry.get('activeImportId') as string | null | undefined;
      if (active) {
        const b = await tx.get(db.collection(COL.importBatches).doc(active));
        if (b.exists && b.get('status') === 'IN_PROGRESS') {
          if (b.get('fingerprint') === input.fingerprint && b.get('createdBy') === ctx.uid) return { importId: active, resumed: true, parts: b.get('parts') as ImportPart[] };
          throw new BfmsError('VALIDATION_FAILED', `An unfinished import of ${bid} ${fy} was started by ${String(b.get('createdByName'))}. Re-run the same workbook as that user to resume it, or close it first.`, { importId: active });
        }
      }
      const reasons = input.parts.filter((p) => st.blocked[p]).map((p) => st.blocked[p]!);
      if (reasons.length) throw new BfmsError('VALIDATION_FAILED', reasons.join(' '), { blocked: st.blocked });
      const audit = await AuditWriter.begin(tx, ctx, bid);
      const now = Timestamp.now();
      const batch: BatchDoc & Record<string, unknown> = {
        kind: 'BATCH',
        barangayId: bid,
        fiscalYear: fy,
        status: 'IN_PROGRESS',
        parts: [...new Set(input.parts)],
        fingerprint: input.fingerprint,
        sourceTitle: input.sourceTitle,
        counts: input.counts,
        lastJevDate: null,
        openingPosted: false,
        progress: {},
        rejected: [],
        createdBy: ctx.uid,
        createdByName: ctx.userName,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(batchRef, batch);
      tx.set(regRef, { kind: 'REGISTRY', barangayId: bid, fiscalYear: fy, activeImportId: batchRef.id, updatedAt: now }, { merge: true });
      audit.write({ module: COL.importBatches, recordId: batchRef.id, action: 'CREATE', newValue: { parts: batch.parts, fingerprint: input.fingerprint, sourceTitle: input.sourceTitle, counts: input.counts }, source: 'callable:importBegin' });
      audit.commit();
      return { importId: batchRef.id, resumed: false, parts: batch.parts };
    });
  },
);

/** Load an IN_PROGRESS batch the caller may continue, and check the part was selected. */
async function loadBatch(importId: string, ctx: CallerContext, part: ImportPart) {
  const ref = db.collection(COL.importBatches).doc(importId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('kind') !== 'BATCH') throw new HttpsError('not-found', 'Import not found.');
  const b = snap.data() as BatchDoc;
  requireImporter(ctx, b.barangayId);
  if (b.status !== 'IN_PROGRESS') throw new BfmsError('INVALID_STATUS', 'This import is already finished; start a new one.');
  if (b.createdBy !== ctx.uid) throw new BfmsError('VALIDATION_FAILED', `This import was started by ${b.createdByName}; only they can continue it.`);
  if (!b.parts.includes(part)) throw new BfmsError('VALIDATION_FAILED', `"${part}" was not selected when this import was started.`);
  return { ref, b };
}

// ---------------------------------------------------------------------------------------------

export const importSubsidiaries = secureCallable(
  z.object({
    importId: importIdSchema,
    subsidiaries: z.array(z.object({ accountCode, subsidiaryCode: slCode, subsidiaryName: z.string().trim().min(1).max(160), type: z.enum(SL_TYPES) })).min(1).max(IMPORT_LIMITS.subsidiariesPerCall),
  }),
  async (input, ctx) => {
    const { ref: batchRef, b } = await loadBatch(input.importId, ctx, 'SUBSIDIARIES');
    const bid = b.barangayId;
    const uniq = [...new Map(input.subsidiaries.map((s) => [subsidiaryId(bid, s.accountCode, s.subsidiaryCode), s])).entries()];
    return db.runTransaction(async (tx) => {
      const codes = [...new Set(uniq.map(([, s]) => s.accountCode))];
      const [accts, existing] = await Promise.all([
        tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c))),
        tx.getAll(...uniq.map(([id]) => db.collection(COL.subsidiaryAccounts).doc(id))),
      ]);
      const known = new Set(accts.filter((s) => s.exists).map((s) => s.id));
      const audit = await AuditWriter.begin(tx, ctx, bid);
      const now = Timestamp.now();
      const created: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      uniq.forEach(([id, s], i) => {
        if (existing[i]!.exists) return skipped.push({ id, reason: 'already exists' });
        if (!known.has(s.accountCode)) return skipped.push({ id, reason: `account ${s.accountCode} is not in the Chart of Accounts` });
        tx.create(existing[i]!.ref, { barangayId: bid, accountCode: s.accountCode, subsidiaryCode: s.subsidiaryCode, subsidiaryName: s.subsidiaryName, type: s.type, partyId: null, active: true, importBatchId: input.importId, createdAt: now, createdBy: ctx.uid, updatedAt: now, updatedBy: ctx.uid });
        created.push(id);
      });
      tx.update(batchRef, { 'progress.SUBSIDIARIES.created': FieldValue.increment(created.length), 'progress.SUBSIDIARIES.existing': FieldValue.increment(skipped.length), updatedAt: now });
      audit.write({ module: COL.subsidiaryAccounts, recordId: input.importId, action: 'IMPORT_COMMIT', newValue: { created: created.length, ids: created.slice(0, 200) }, source: 'callable:importSubsidiaries' });
      audit.commit();
      return { created: created.length, skipped };
    });
  },
);

// ---------------------------------------------------------------------------------------------
// Journal entries (opening + current-year journal): create AND post.

interface Prepared {
  e: EntryInput;
  ref: DocumentReference;
  month: number;
  lines: JournalLineInput[];
  deltas: BalanceDelta[];
}

function prepare(bid: BarangayId, fy: number, kind: 'OPENING' | 'JOURNAL', e: EntryInput, importId: string): Prepared {
  const month = kind === 'OPENING' ? 0 : Number(e.date.slice(5, 7));
  const lines: JournalLineInput[] = e.lines.map((l) => ({
    accountCode: l.accountCode,
    subsidiaryId: l.subsidiaryCode ? subsidiaryId(bid, l.accountCode, l.subsidiaryCode) : null,
    debit: l.debit as Centavos,
    credit: l.credit as Centavos,
    lineDescription: '',
    fppId: null,
    officeId: null,
  }));
  return { e, ref: db.collection(COL.journalEntries).doc(jevDocId(importId, e.key)), month, lines, deltas: balanceDeltas(bid, fy, month, 'GF', lines) };
}

/** Group prepared entries into transactions under the 500-write limit (balance rows shared within a chunk). */
function chunkByWrites(list: Prepared[]): Prepared[][] {
  const out: Prepared[][] = [];
  let cur: Prepared[] = [];
  let ids = new Set<string>();
  let writes = 6; // batch doc, sequence, audit log, audit chain, fiscal-year flag, spare
  for (const p of list) {
    const own = 3 + p.lines.length; // header, unique key, workflow history, lines
    const newIds = p.deltas.filter((d) => !ids.has(d.id)).length;
    if (cur.length && writes + own + newIds > WRITE_BUDGET) {
      out.push(cur);
      cur = [];
      ids = new Set();
      writes = 6;
    }
    cur.push(p);
    writes += own + p.deltas.filter((d) => !ids.has(d.id)).length;
    p.deltas.forEach((d) => ids.add(d.id));
  }
  if (cur.length) out.push(cur);
  return out;
}

const entriesInput = z.object({ importId: importIdSchema, kind: z.enum(['OPENING', 'JOURNAL']), entries: z.array(entrySchema).min(1).max(IMPORT_LIMITS.entriesPerCall) });

export const importEntries = secureCallable(
  entriesInput,
  async (input, ctx) => {
    const { ref: batchRef, b } = await loadBatch(input.importId, ctx, input.kind);
    const bid = b.barangayId;
    const fy = b.fiscalYear;
    if (input.kind === 'OPENING' && input.entries.length !== 1) throw new HttpsError('invalid-argument', 'The opening balances are imported as exactly one entry.');
    if (input.kind === 'JOURNAL' && b.parts.includes('OPENING') && !b.openingPosted)
      throw new BfmsError('VALIDATION_FAILED', 'Import the opening balances first (they take the first JEV number of the year).');
    if (new Set(input.entries.map((e) => e.key)).size !== input.entries.length) throw new HttpsError('invalid-argument', 'Duplicate entry keys in the batch.');
    for (let i = 1; i < input.entries.length; i++)
      if (input.entries[i]!.date < input.entries[i - 1]!.date) throw new HttpsError('invalid-argument', 'Entries must be sent in date order (JEV numbers follow the dates).');
    const prepared = input.entries.map((e) => prepare(bid, fy, input.kind, e, input.importId));
    const posted: Array<{ key: string; jevId: string; jevNumber: string }> = [];
    const skipped: string[] = [];
    const rejected: Array<{ key: string; reason: string }> = [];
    for (const group of chunkByWrites(prepared)) {
      const r = await postChunk(ctx, batchRef, input.importId, input.kind, group);
      posted.push(...r.posted);
      skipped.push(...r.skipped);
      rejected.push(...r.rejected);
    }
    return { posted, skipped, rejected };
  },
  { timeoutSeconds: 300, memory: '512MiB' },
);

async function postChunk(ctx: CallerContext, batchRef: DocumentReference, importId: string, kind: 'OPENING' | 'JOURNAL', group: Prepared[]) {
  return db.runTransaction(async (tx) => {
    const posted: Array<{ key: string; jevId: string; jevNumber: string }> = [];
    const skipped: string[] = [];
    const rejected: Array<{ key: string; reason: string }> = [];
    // ---- READ PHASE
    const bsnap = await tx.get(batchRef);
    const b = bsnap.data() as BatchDoc;
    if (b.status !== 'IN_PROGRESS') throw new BfmsError('INVALID_STATUS', 'This import is already finished.');
    const bid = b.barangayId;
    const fy = b.fiscalYear;
    const months = [...new Set(group.map((p) => p.month))];
    const codes = [...new Set(group.flatMap((p) => p.lines.map((l) => l.accountCode)))];
    const sls = [...new Set(group.flatMap((p) => p.lines.map((l) => l.subsidiaryId).filter((s): s is string => !!s)))];
    const bfyRef = db.collection(COL.barangayFiscalYears).doc(`${bid}_${fy}`);
    const [periodSnaps, acctSnaps, slSnaps, existing, bfy] = await Promise.all([
      tx.getAll(...months.map((m) => db.collection(COL.accountingPeriods).doc(periodDocId(bid, fy, m)))),
      tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c))),
      sls.length ? tx.getAll(...sls.map((s) => db.collection(COL.subsidiaryAccounts).doc(s))) : Promise.resolve([]),
      tx.getAll(...group.map((p) => p.ref)),
      tx.get(bfyRef),
    ]);
    const periods = new Map(periodSnaps.map((s, i) => [months[i]!, s.get('status') as PeriodStatus | undefined]));
    const accounts = new Map(acctSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as ChartOfAccountDoc]));
    const subsidiaries = new Map(slSnaps.filter((s) => s.exists).map((s) => [s.id, s.data() as SubsidiaryAccountDoc]));
    const seq = await SequenceAllocator.read(tx, bid, fy, 'JEV');
    const audit = await AuditWriter.begin(tx, ctx, bid);

    const valid: Array<Prepared & { totals: { totalDebit: Centavos; totalCredit: Centavos } }> = [];
    let lastDate = b.lastJevDate ?? '';
    group.forEach((p, i) => {
      if (existing[i]!.exists) {
        skipped.push(p.e.key);
        return;
      }
      try {
        const date = assertIsoDate(p.e.date, 'date');
        if (Number(date.slice(0, 4)) !== fy) throw new BfmsError('PERIOD_MISMATCH', `Date ${date} is outside fiscal year ${fy}.`);
        if (kind === 'OPENING' && date !== `${fy}-01-01`) throw new BfmsError('VALIDATION_FAILED', `The opening entry must be dated ${fy}-01-01.`);
        if (kind === 'JOURNAL' && date < lastDate) throw new BfmsError('VALIDATION_FAILED', `Date ${date} is before the last imported entry (${lastDate}); JEV numbers must follow the dates.`);
        assertPeriodAllowsPosting(periods.get(p.month), kind === 'OPENING' ? 'OPENING' : 'REGULAR');
        const totals = validateJournalBalance(p.lines);
        validateJournalAccounts(p.lines, bid, accounts, subsidiaries);
        valid.push({ ...p, totals });
        if (kind === 'JOURNAL') lastDate = date;
      } catch (err) {
        if (err instanceof BfmsError) {
          const d = err.details as { difference?: number } | undefined;
          rejected.push({ key: p.e.key, reason: d?.difference ? `${err.message} Difference ${(d.difference / 100).toFixed(2)}.` : err.message });
        } else throw err;
      }
    });

    // ---- WRITE PHASE
    const now = Timestamp.now();
    const balances = new Map<string, BalanceDelta & { month: number }>();
    for (const p of valid) {
      const entryType = kind === 'OPENING' ? 'OPENING' : 'REGULAR';
      const key = periodKey(fy, p.month);
      const jevNumber = seq.allocate(p.month === 0 ? 1 : p.month, COL.journalEntries, p.ref.id);
      const journal = bookForLines(p.lines);
      const header: Omit<JournalEntryDoc, 'submittedBy'> & Record<string, unknown> = {
        barangayId: bid,
        fiscalYear: fy,
        accountingPeriod: key,
        jevNumber,
        jevDate: p.e.date,
        fundId: 'GF',
        journal,
        entryType,
        transactionType: p.e.transactionType,
        payeeName: p.e.payeeName,
        sourceModule: 'IMPORT',
        sourceDocumentId: importId,
        primaryReference: p.e.primaryReference,
        secondaryReference: p.e.secondaryReference,
        tertiaryReference: p.e.tertiaryReference,
        particulars: p.e.particulars,
        totalDebit: p.totals.totalDebit,
        totalCredit: p.totals.totalCredit,
        lineCount: p.lines.length,
        reversesJevId: null,
        reversedByJevId: null,
        status: 'POSTED',
        revisionNumber: 0,
        importBatchId: importId,
        importKey: p.e.key,
        legacyRows: p.e.legacyRows,
        createdAt: now,
        createdBy: ctx.uid,
        updatedAt: now,
        updatedBy: ctx.uid,
        approvedBy: ctx.uid,
        approvedAt: now,
        postedBy: ctx.uid,
        postedAt: now,
      };
      tx.create(p.ref, header);
      p.lines.forEach((l, i) => {
        const line: JournalLineDoc = {
          barangayId: bid,
          fiscalYear: fy,
          accountingPeriod: key,
          fundId: 'GF',
          jevId: p.ref.id,
          jevDate: p.e.date,
          jevNumber,
          journal,
          entryType,
          posted: true,
          lineNo: i + 1,
          accountCode: l.accountCode,
          subsidiaryId: l.subsidiaryId ?? null,
          debit: l.debit,
          credit: l.credit,
          lineDescription: '',
          primaryReference: p.e.primaryReference,
          secondaryReference: p.e.secondaryReference,
          payeeName: p.e.payeeName,
          fppId: null,
          officeId: null,
        };
        tx.create(p.ref.collection(COL.lines).doc(String(i + 1).padStart(3, '0')), line);
      });
      writeWorkflowHistory(tx, ctx, { barangayId: bid, module: 'journalEntries', recordId: p.ref.id, fromStatus: null, toStatus: 'POSTED', remarks: `Imported from legacy workbook (import ${importId}, ${p.e.key})` });
      for (const d of p.deltas) {
        const cur = balances.get(d.id);
        if (cur) {
          cur.debit = (cur.debit + d.debit) as Centavos;
          cur.credit = (cur.credit + d.credit) as Centavos;
          cur.lineCount += d.lineCount;
        } else balances.set(d.id, { ...d, month: p.month });
      }
      posted.push({ key: p.e.key, jevId: p.ref.id, jevNumber });
    }
    seq.commit();
    for (const d of balances.values()) {
      tx.set(
        db.collection(COL.accountBalances).doc(d.id),
        {
          barangayId: bid,
          fiscalYear: fy,
          month: d.month,
          accountingPeriod: periodKey(fy, d.month),
          fundId: 'GF',
          accountCode: d.accountCode,
          subsidiaryId: d.subsidiaryId,
          debit: FieldValue.increment(d.debit),
          credit: FieldValue.increment(d.credit),
          lineCount: FieldValue.increment(d.lineCount),
          updatedAt: now,
        },
        { merge: true },
      );
    }
    const patch: Record<string, unknown> = {
      [`progress.${kind}.posted`]: FieldValue.increment(posted.length),
      [`progress.${kind}.rejected`]: FieldValue.increment(rejected.length),
      updatedAt: now,
    };
    if (rejected.length) patch.rejected = FieldValue.arrayUnion(...rejected.slice(0, 50).map((r) => ({ kind, ...r })));
    if (kind === 'JOURNAL' && lastDate) patch.lastJevDate = lastDate;
    if (kind === 'OPENING' && (posted.length || skipped.length)) patch.openingPosted = true;
    tx.update(batchRef, patch);
    if (kind === 'OPENING' && posted.length && bfy.exists) tx.update(bfyRef, { openingBalancesPosted: true });
    if (posted.length || rejected.length) {
      audit.write({
        module: 'journalEntries',
        recordId: importId,
        action: 'IMPORT_COMMIT',
        newValue: {
          kind,
          posted: posted.length,
          firstJevNumber: posted[0]?.jevNumber ?? null,
          lastJevNumber: posted[posted.length - 1]?.jevNumber ?? null,
          totalDebit: valid.reduce((s, p) => s + p.totals.totalDebit, 0),
          rejected: rejected.slice(0, 50),
        },
        source: 'callable:importEntries',
      });
      audit.commit();
    }
    return { posted, skipped, rejected };
  });
}

// ---------------------------------------------------------------------------------------------
// Reference data: prior-year TB, legacy cash advances, PPE schedule, cancelled checks

const referenceInput = z.object({
  importId: importIdSchema,
  priorYears: z.array(z.object({ fiscalYear: year, rows: z.array(z.object({ accountCode, debit: centavos, credit: centavos })).max(600) })).max(2).optional(),
  cashAdvances: z
    .object({
      offset: z.number().int().min(0),
      items: z
        .array(
          z.object({
            accountCode,
            subsidiaryCode: slCode.nullable(),
            officerName: z.string().trim().min(1).max(160),
            date: isoDate,
            checkNumber: z.string().trim().max(40).nullable(),
            dvNumber: z.string().trim().max(60).nullable(),
            particulars: z.string().max(500),
            amount: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
          }),
        )
        .min(1)
        .max(IMPORT_LIMITS.cashAdvancesPerCall),
    })
    .optional(),
  ppe: z
    .array(
      z.object({
        accountCode,
        costOverride: centavos.nullable(),
        residualRateBp: z.number().int().min(0).max(10000),
        usefulLifeYears: z.number().int().min(1).max(100),
        accumulatedAccountCode: accountCode,
        expenseAccountCode: accountCode,
        remarks: z.string().max(500),
      }),
    )
    .max(100)
    .optional(),
  cancelledChecks: z
    .object({
      bankAccountId: z.string().min(1).max(128),
      items: z
        .array(z.object({ checkNumber: z.string().trim().regex(/^[0-9A-Za-z-]{3,20}$/), checkDate: isoDate, payeeName: z.string().trim().max(200).nullable(), dvNumber: z.string().trim().max(60).nullable() }))
        .min(1)
        .max(IMPORT_LIMITS.cancelledChecksPerCall),
    })
    .optional(),
});

export const importReference = secureCallable(referenceInput, async (input, ctx) => {
  const part: ImportPart = input.priorYears ? 'PRIOR_YEARS' : input.cashAdvances ? 'CASH_ADVANCES' : input.ppe ? 'PPE' : 'CANCELLED_CHECKS';
  if ([input.priorYears, input.cashAdvances, input.ppe, input.cancelledChecks].filter(Boolean).length !== 1)
    throw new HttpsError('invalid-argument', 'Send exactly one of priorYears, cashAdvances, ppe, cancelledChecks.');
  const { ref: batchRef, b } = await loadBatch(input.importId, ctx, part);
  const bid = b.barangayId;
  const fy = b.fiscalYear;
  const source = `${b.sourceTitle || 'legacy workbook'} (import ${input.importId})`;

  return db.runTransaction(async (tx) => {
    const now = Timestamp.now();
    const created: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    if (input.priorYears) {
      const refs = input.priorYears.map((y) => db.collection(COL.legacyBalances).doc(`${bid}_${y.fiscalYear}`));
      const snaps = await tx.getAll(...refs);
      const audit = await AuditWriter.begin(tx, ctx, bid);
      input.priorYears.forEach((y, i) => {
        if (y.fiscalYear >= fy) return skipped.push({ id: refs[i]!.id, reason: 'not a prior year' });
        if (snaps[i]!.exists) return skipped.push({ id: refs[i]!.id, reason: 'already imported' });
        const rows = y.rows.filter((r) => r.debit !== r.credit).map((r) => (r.debit > r.credit ? { accountCode: r.accountCode, debit: r.debit - r.credit, credit: 0 } : { accountCode: r.accountCode, debit: 0, credit: r.credit - r.debit }));
        tx.create(refs[i]!, { barangayId: bid, fiscalYear: y.fiscalYear, kind: 'PRE_CLOSING_TB', rows, source, importedAt: now, importedBy: ctx.uid, importBatchId: input.importId });
        created.push(refs[i]!.id);
      });
      tx.update(batchRef, { 'progress.PRIOR_YEARS.created': FieldValue.increment(created.length), updatedAt: now });
      audit.write({ module: COL.legacyBalances, recordId: input.importId, action: 'IMPORT_COMMIT', newValue: { created, skipped }, source: 'callable:importReference' });
      audit.commit();
    } else if (input.cashAdvances) {
      const { offset, items } = input.cashAdvances;
      const refs = items.map((_, i) => db.collection(COL.legacyCashAdvances).doc(`IMP-${input.importId}-CA-${offset + i}`));
      const slIds = [...new Set(items.filter((c) => c.subsidiaryCode).map((c) => subsidiaryId(bid, c.accountCode, c.subsidiaryCode!)))];
      const [snaps, slSnaps] = await Promise.all([tx.getAll(...refs), slIds.length ? tx.getAll(...slIds.map((s) => db.collection(COL.subsidiaryAccounts).doc(s))) : Promise.resolve([])]);
      const slOk = new Set(slSnaps.filter((s) => s.exists).map((s) => s.id));
      const audit = await AuditWriter.begin(tx, ctx, bid);
      let total = 0;
      items.forEach((c, i) => {
        if (snaps[i]!.exists) return skipped.push({ id: refs[i]!.id, reason: 'already imported' });
        const sl = c.subsidiaryCode ? subsidiaryId(bid, c.accountCode, c.subsidiaryCode) : null;
        tx.create(refs[i]!, {
          barangayId: bid,
          fiscalYear: fy,
          accountCode: c.accountCode,
          subsidiaryId: sl && slOk.has(sl) ? sl : null,
          officerName: c.officerName,
          date: c.date,
          checkNumber: c.checkNumber,
          dvNumber: c.dvNumber,
          particulars: c.particulars,
          amount: c.amount,
          source,
          importBatchId: input.importId,
          createdAt: now,
          createdBy: ctx.uid,
        });
        total += c.amount;
        created.push(refs[i]!.id);
      });
      tx.update(batchRef, { 'progress.CASH_ADVANCES.created': FieldValue.increment(created.length), updatedAt: now });
      audit.write({ module: COL.legacyCashAdvances, recordId: input.importId, action: 'IMPORT_COMMIT', newValue: { created: created.length, offset, total }, source: 'callable:importReference' });
      audit.commit();
    } else if (input.ppe) {
      const ref = db.collection(COL.ppeSchedules).doc(`${bid}_${fy}`);
      const codes = [...new Set(input.ppe.flatMap((r) => [r.accountCode, r.accumulatedAccountCode, r.expenseAccountCode]))];
      const [snap, accts] = await Promise.all([tx.get(ref), tx.getAll(...codes.map((c) => db.collection(COL.chartOfAccounts).doc(c)))]);
      if (snap.exists) throw new BfmsError('VALIDATION_FAILED', `A ${fy} PPE schedule already exists; edit it in Schedules.`);
      const known = new Set(accts.filter((s) => s.exists).map((s) => s.id));
      const rows = input.ppe.filter((r) => {
        const bad = [r.accountCode, r.accumulatedAccountCode, r.expenseAccountCode].find((c) => !known.has(c));
        if (bad) skipped.push({ id: r.accountCode, reason: `account ${bad} is not in the Chart of Accounts` });
        else if (!/^1-07-/.test(r.accountCode) && !/^1-06-/.test(r.accountCode)) skipped.push({ id: r.accountCode, reason: 'not a PPE account' });
        else return true;
        return false;
      });
      const audit = await AuditWriter.begin(tx, ctx, bid);
      tx.create(ref, { barangayId: bid, fiscalYear: fy, rows, updatedAt: now, updatedBy: ctx.uid, importBatchId: input.importId });
      created.push(ref.id);
      tx.update(batchRef, { 'progress.PPE.rows': rows.length, updatedAt: now });
      audit.write({ module: COL.ppeSchedules, recordId: ref.id, action: 'IMPORT_COMMIT', newValue: { rows: rows.length, skipped }, source: 'callable:importReference' });
      audit.commit();
    } else if (input.cancelledChecks) {
      const { bankAccountId, items } = input.cancelledChecks;
      const bank = await tx.get(db.collection(COL.bankAccounts).doc(bankAccountId));
      if (!bank.exists || bank.get('barangayId') !== bid) throw new HttpsError('failed-precondition', 'Bank account not found for this barangay.');
      const refs = items.map((c) => db.collection(COL.cancelledChecks).doc(uniqueKeyId('CXL', bid, bankAccountId, c.checkNumber)));
      const snaps = await tx.getAll(...refs);
      const audit = await AuditWriter.begin(tx, ctx, bid);
      const seen = new Set<string>();
      items.forEach((c, i) => {
        if (snaps[i]!.exists || seen.has(refs[i]!.id)) return skipped.push({ id: c.checkNumber, reason: 'already recorded' });
        if (Number(c.checkDate.slice(0, 4)) !== fy) return skipped.push({ id: c.checkNumber, reason: `dated outside ${fy}` });
        seen.add(refs[i]!.id);
        tx.create(refs[i]!, { barangayId: bid, bankAccountId, checkNumber: c.checkNumber, checkDate: c.checkDate, fiscalYear: fy, payeeName: c.payeeName, remarks: c.dvNumber ? `Cancelled check (legacy DV ${c.dvNumber})` : 'Cancelled check (legacy workbook)', importBatchId: input.importId, createdAt: now, createdBy: ctx.uid, updatedAt: now, updatedBy: ctx.uid });
        created.push(c.checkNumber);
      });
      tx.update(batchRef, { 'progress.CANCELLED_CHECKS.created': FieldValue.increment(created.length), updatedAt: now });
      audit.write({ module: COL.cancelledChecks, recordId: input.importId, action: 'IMPORT_COMMIT', newValue: { created: created.length, skipped: skipped.length }, source: 'callable:importReference' });
      audit.commit();
    }
    return { created: created.length, skipped };
  });
});

// ---------------------------------------------------------------------------------------------

export const importFinish = secureCallable(z.object({ importId: importIdSchema }), async ({ importId }, ctx) => {
  const ref = db.collection(COL.importBatches).doc(importId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('kind') !== 'BATCH') throw new HttpsError('not-found', 'Import not found.');
    const b = snap.data() as BatchDoc & { progress?: Record<string, Record<string, number>> };
    requireImporter(ctx, b.barangayId);
    if (b.status !== 'IN_PROGRESS') return { status: b.status, progress: b.progress ?? {} };
    const regRef = db.collection(COL.importBatches).doc(registryId(b.barangayId, b.fiscalYear));
    const reg = await tx.get(regRef);
    const audit = await AuditWriter.begin(tx, ctx, b.barangayId);
    const now = Timestamp.now();
    tx.update(ref, { status: 'COMPLETED', completedAt: now, completedBy: ctx.uid, updatedAt: now });
    const done: Record<string, string> = {};
    for (const p of b.parts) if (b.progress?.[p]) done[`done.${p}`] = importId;
    if (reg.exists && reg.get('activeImportId') === importId) tx.update(regRef, { activeImportId: null, updatedAt: now, ...done });
    audit.write({ module: COL.importBatches, recordId: importId, action: 'IMPORT_COMMIT', newValue: { status: 'COMPLETED', parts: b.parts, progress: b.progress ?? {} }, source: 'callable:importFinish' });
    audit.commit();
    return { status: 'COMPLETED', progress: b.progress ?? {} };
  });
});
