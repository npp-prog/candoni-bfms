import {
  BARANGAY_IDS,
  BfmsError,
  COL,
  assertIsoDate,
  assertPeriodAllowsEncoding,
  assertSegregation,
  matchingTransitions,
  periodDocId,
  periodOfDate,
  type AuditAction,
  type BarangayId,
  type NumberedDocType,
  type PeriodStatus,
  type SourceModuleDef,
} from '@bfms/shared';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter, diffFields, writeWorkflowHistory } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';
import type { CallerContext } from '../lib/context';
import { SequenceAllocator } from '../numbering/sequences';
import { createGeneratedJev, type GeneratedJev } from './jev';

export type SourceRecord = Record<string, unknown> & { id: string; barangayId: BarangayId; fiscalYear: number; status: string; createdBy: string };

/** Values available to every hook's WRITE phase. */
export interface WriteArgs {
  now: FirebaseFirestore.Timestamp;
  /** Number allocated by the module's `numbering` rule for this action (if any). */
  number: string | null;
  /** JEV generated on ACCEPT (if any). */
  jevId: string | null;
}

/**
 * Two-phase hook (Firestore requires every read before the first write):
 *  READ phase — the hook body: tx.get(...), validate, throw BfmsError to reject.
 *  WRITE phase — the returned function: tx.set/update other documents; may return extra fields
 *  to merge into the source document's update.
 */
export type Hook<A> = (args: A) => Promise<null | void | ((w: WriteArgs) => Record<string, unknown> | void)>;

export interface PrepareArgs<I> {
  input: I;
  barangayId: BarangayId;
  tx: Transaction;
  ctx: CallerContext;
  /** Current document when editing (null on create). */
  existing: SourceRecord | null;
  /** Id the document will have (useful for back-links). */
  id: string;
}

export interface ActionArgs {
  tx: Transaction;
  ctx: CallerContext;
  doc: SourceRecord;
  ref: DocumentReference;
  action: string;
  to: string;
  remarks: string | null;
  /** Extra, module-specific input sent with the action (validated by `actionPayload`). */
  payload: Record<string, unknown>;
}

export interface ServerSourceModule<S extends z.ZodTypeAny = z.ZodTypeAny> {
  def: SourceModuleDef;
  /** Client input for saveSource (fields the encoder controls). */
  schema: S;
  /**
   * READ phase of save: validate input, read related documents, return the fields to store.
   * Must include the def.dateField. May include `fiscalYear` (else derived from the date).
   * Never return workflow fields (status, stamps) — the engine owns them.
   */
  prepare(args: PrepareArgs<z.infer<S>>): Promise<Record<string, unknown>>;
  /** Skip the accounting-period gate for save/submit (year-scoped records such as appropriations). */
  skipPeriodCheck?: boolean;
  /** Optional extra input per action (e.g. ISSUE needs a check number). */
  actionPayload?: Partial<Record<string, z.ZodTypeAny>>;
  /** Per-action side effects. */
  onAction?: Partial<Record<string, Hook<ActionArgs>>>;
  /** Document number allocated when an action succeeds. */
  numbering?: { action: string | readonly string[]; docType: NumberedDocType; field: string };
  /** READ phase on ACCEPT: build the journal entry to generate (null = no JEV). */
  jev?: (args: ActionArgs) => Promise<GeneratedJev | null>;
}

const REGISTRY = new Map<string, ServerSourceModule>();

export function registerSourceModules(mods: readonly ServerSourceModule[]): void {
  for (const m of mods) {
    if (REGISTRY.has(m.def.key)) throw new Error(`Duplicate source module ${m.def.key}`);
    REGISTRY.set(m.def.key, m);
  }
}

function getModule(key: string): ServerSourceModule {
  const m = REGISTRY.get(key);
  if (!m) throw new HttpsError('invalid-argument', `Unknown module "${key}".`);
  return m;
}

const STAMPS: Record<string, [string, string]> = {
  SUBMIT: ['submittedBy', 'submittedAt'],
  RESUBMIT: ['submittedBy', 'submittedAt'],
  APPROVE: ['approvedBy', 'approvedAt'],
  ACCEPT: ['acceptedBy', 'acceptedAt'],
  VOID: ['voidedBy', 'voidedAt'],
  CANCEL: ['voidedBy', 'voidedAt'],
  CERTIFY: ['certifiedBy', 'certifiedAt'],
};

const AUDIT_FOR: Record<string, AuditAction> = {
  SUBMIT: 'SUBMIT',
  RESUBMIT: 'RESUBMIT',
  APPROVE: 'APPROVE',
  ACCEPT: 'ACCEPT',
  RETURN: 'RETURN',
  VOID: 'VOID',
  CERTIFY: 'CERTIFY',
  ISSUE: 'ISSUE',
  RELEASE: 'RELEASE',
  CANCEL: 'CANCEL',
  CLEAR: 'CLEAR',
  POST: 'POST',
};

async function readPeriodStatus(tx: Transaction, barangayId: BarangayId, date: string): Promise<PeriodStatus | undefined> {
  const { fiscalYear, month } = periodOfDate(assertIsoDate(date));
  const p = await tx.get(db.collection(COL.accountingPeriods).doc(periodDocId(barangayId, fiscalYear, month)));
  return p.get('status') as PeriodStatus | undefined;
}

const barangayEnum = z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]);

/** Create or edit a DRAFT/RETURNED source document. */
export const saveSource = secureCallable(
  z.object({ module: z.string().min(1).max(60), id: z.string().max(128).nullish(), barangayId: barangayEnum, data: z.unknown() }),
  async (req, ctx) => {
    const mod = getModule(req.module);
    const def = mod.def;
    ctx.require(def.encodePermission, req.barangayId);
    const parsed = mod.schema.safeParse(req.data);
    if (!parsed.success)
      throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const ref = req.id ? db.collection(def.collection).doc(req.id) : db.collection(def.collection).doc();

    await db.runTransaction(async (tx) => {
      let existing: SourceRecord | null = null;
      if (req.id) {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', `${def.label} not found.`);
        existing = { ...snap.data(), id: snap.id } as SourceRecord;
        if (existing.barangayId !== req.barangayId) throw new BfmsError('BARANGAY_MISMATCH', 'The barangay of a record cannot be changed.');
        if (!def.editableStatuses.includes(existing.status))
          throw new BfmsError('INVALID_STATUS', `A ${existing.status} ${def.label.toLowerCase()} can no longer be edited.`);
      }
      const fields = await mod.prepare({ input: parsed.data, barangayId: req.barangayId, tx, ctx, existing, id: ref.id });
      const date = fields[def.dateField] as string | undefined;
      if (!date) throw new BfmsError('VALIDATION_FAILED', `${def.dateField} is required.`);
      const { fiscalYear: dateYear, key } = periodOfDate(assertIsoDate(date, def.dateField));
      if (!mod.skipPeriodCheck) assertPeriodAllowsEncoding(await readPeriodStatus(tx, req.barangayId, date));
      const audit = await AuditWriter.begin(tx, ctx, req.barangayId);

      const now = Timestamp.now();
      const body = { ...fields, barangayId: req.barangayId, fiscalYear: (fields.fiscalYear as number | undefined) ?? dateYear, accountingPeriod: key, updatedAt: now, updatedBy: ctx.uid };
      if (!existing) {
        tx.create(ref, { ...body, status: 'DRAFT', revisionNumber: 0, createdAt: now, createdBy: ctx.uid, jevId: null });
        audit.write({ module: def.collection, recordId: ref.id, action: 'CREATE', newValue: summarize(body), source: `callable:saveSource:${def.key}` });
      } else {
        tx.update(ref, body);
        const d = diffFields(existing, { ...existing, ...body });
        audit.write({ module: def.collection, recordId: ref.id, action: 'EDIT', oldValue: d.oldValue, newValue: d.newValue, source: `callable:saveSource:${def.key}` });
      }
      audit.commit();
    });
    return { id: ref.id };
  },
);

/** Keep CREATE audit payloads small: scalars only. */
function summarize(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  return out;
}

/** Run a workflow transition on a source document. */
export const sourceAction = secureCallable(
  z.object({
    module: z.string().min(1).max(60),
    id: z.string().min(1).max(128),
    action: z.string().min(1).max(40),
    remarks: z.string().max(1000).nullish(),
    payload: z.record(z.unknown()).nullish(),
  }),
  async (req, ctx) => {
    const mod = getModule(req.module);
    const def = mod.def;
    const ref = db.collection(def.collection).doc(req.id);
    const payloadSchema = mod.actionPayload?.[req.action];
    let payload: Record<string, unknown> = req.payload ?? {};
    if (payloadSchema) {
      const p = payloadSchema.safeParse(payload);
      if (!p.success) throw new HttpsError('invalid-argument', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      payload = p.data as Record<string, unknown>;
    }

    return db.runTransaction(async (tx) => {
      // ---- READ PHASE
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', `${def.label} not found.`);
      const doc = { ...snap.data(), id: snap.id } as SourceRecord;
      const candidates = matchingTransitions(def, req.action, doc.status);
      if (!candidates.length) throw new BfmsError('INVALID_STATUS', `"${req.action}" is not allowed while the ${def.label.toLowerCase()} is ${doc.status}.`);
      const t = candidates.find((c) => ctx.can(c.permission, doc.barangayId));
      if (!t) {
        ctx.requireBarangay(doc.barangayId);
        throw new HttpsError('permission-denied', `You do not have the "${candidates[0]!.permission}" permission for ${doc.barangayId}.`);
      }
      const remarks = req.remarks?.trim() || null;
      if (t.requiresReason && (!remarks || remarks.length < 5)) throw new HttpsError('invalid-argument', 'Please state the reason (at least 5 characters).');
      if (t.segregation) {
        const settings = await tx.get(db.collection(COL.systemSettings).doc('global'));
        assertSegregation(doc.createdBy, ctx.uid, t.label.replace(/[…&].*$/, '').trim() || req.action, settings.get('allowSelfPost') === true);
      }
      if ((req.action === 'SUBMIT' || req.action === 'RESUBMIT') && !mod.skipPeriodCheck)
        assertPeriodAllowsEncoding(await readPeriodStatus(tx, doc.barangayId, String(doc[def.dateField])));

      const args: ActionArgs = { tx, ctx, doc, ref, action: req.action, to: t.to, remarks, payload };
      const writer = await mod.onAction?.[req.action]?.(args);
      const jev = req.action === 'ACCEPT' && mod.jev ? await mod.jev(args) : null;
      const numbering = mod.numbering && ([] as string[]).concat(mod.numbering.action).includes(req.action) && !doc[mod.numbering.field] ? mod.numbering : null;
      const seq = numbering ? await SequenceAllocator.read(tx, doc.barangayId, doc.fiscalYear, numbering.docType) : null;
      const audit = await AuditWriter.begin(tx, ctx, doc.barangayId);

      // ---- WRITE PHASE
      const now = Timestamp.now();
      let number: string | null = null;
      if (seq && numbering) {
        const month = Number(String(doc[def.dateField]).slice(5, 7));
        number = seq.allocate(month, def.collection, doc.id);
        seq.commit();
      }
      const jevId = jev && def.jevSource ? createGeneratedJev(tx, ctx, { barangayId: doc.barangayId, sourceModule: def.jevSource, sourceDocumentId: doc.id }, jev) : null;
      const extra = (typeof writer === 'function' ? writer({ now, number, jevId }) : null) ?? {};

      const patch: Record<string, unknown> = { status: t.to, updatedAt: now, updatedBy: ctx.uid, ...extra };
      const stamp = STAMPS[req.action];
      if (stamp) Object.assign(patch, { [stamp[0]]: ctx.uid, [stamp[1]]: now });
      if (req.action === 'VOID' || req.action === 'CANCEL') patch.voidReason = remarks;
      if (req.action === 'ACCEPT') Object.assign(patch, { reviewedBy: ctx.uid, reviewedAt: now });
      if (number && numbering) patch[numbering.field] = number;
      if (jevId) patch.jevId = jevId;
      if (req.action === 'RETURN') {
        const info = {
          reasonForReturn: remarks!,
          requiredCorrection: remarks!,
          returnedBy: ctx.uid,
          returnedAt: now,
          assignedTo: doc.createdBy,
          revisionNumber: ((doc.revisionNumber as number | undefined) ?? 0) + 1,
        };
        Object.assign(patch, { returnInfo: info, returnHistory: [...((doc.returnHistory as unknown[] | undefined) ?? []), info], revisionNumber: info.revisionNumber });
      }
      tx.update(ref, patch);
      writeWorkflowHistory(tx, ctx, { barangayId: doc.barangayId, module: def.collection, recordId: doc.id, fromStatus: doc.status, toStatus: t.to, remarks });
      audit.write({
        module: def.collection,
        recordId: doc.id,
        action: t.auditAction ?? AUDIT_FOR[req.action] ?? 'EDIT',
        oldValue: { status: doc.status },
        newValue: { status: t.to, ...(number ? { number } : {}), ...(jevId ? { jevId } : {}) },
        reason: remarks,
        source: `callable:sourceAction:${def.key}:${req.action}`,
      });
      audit.commit();
      return { status: t.to, number, jevId };
    });
  },
);
