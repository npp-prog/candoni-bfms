import { BARANGAY_IDS, BfmsError, COL, NFS_LIMITS, nfsNarrativeId, type BarangayId, type NfsNarrativeDoc } from '@bfms/shared';
import { z } from 'zod';
import { AuditWriter } from '../../audit/auditWriter';
import { db, Timestamp } from '../../lib/admin';
import { secureCallable } from '../../lib/callable';

/**
 * Notes to Financial Statements — narrative blocks (docs 06 §16 item 8). One document per
 * barangay and year (`nfsNarratives/{bid}_{fy}`); every save bumps `version` and keeps the full
 * text in `versions/{n}` so earlier wording can be recovered. A FINAL document (frozen by the
 * Phase 12 finalize step) can no longer be edited. `expectedVersion` guards against two editors
 * overwriting each other.
 */
export const saveNfsNarrative = secureCallable(
  z.object({
    barangayId: z.enum(BARANGAY_IDS as [BarangayId, ...BarangayId[]]),
    fiscalYear: z.number().int().min(2000).max(2100),
    expectedVersion: z.number().int().min(0).optional(),
    notes: z
      .array(z.object({ title: z.string().trim().min(2).max(NFS_LIMITS.maxTitle), body: z.string().max(NFS_LIMITS.maxBody).transform((s) => s.replace(/\r\n/g, '\n').trimEnd()) }))
      .min(1)
      .max(NFS_LIMITS.maxNotes),
  }),
  async (input, ctx) => {
    ctx.require('nfs.edit', input.barangayId);
    const id = nfsNarrativeId(input.barangayId, input.fiscalYear);
    const ref = db.collection(COL.nfsNarratives).doc(id);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() as NfsNarrativeDoc) : null;
      if (cur?.status === 'FINAL') throw new BfmsError('INVALID_STATUS', 'The notes to financial statements are final and can no longer be edited.');
      const version = (cur?.version ?? 0) + 1;
      if (input.expectedVersion !== undefined && input.expectedVersion !== (cur?.version ?? 0))
        throw new BfmsError('VALIDATION_FAILED', `Someone else saved these notes (version ${cur?.version ?? 0}) after you opened them. Reload and apply your changes again.`, { currentVersion: cur?.version ?? 0 });
      const audit = await AuditWriter.begin(tx, ctx, input.barangayId);
      const now = Timestamp.now();
      tx.set(ref, {
        barangayId: input.barangayId,
        fiscalYear: input.fiscalYear,
        notes: input.notes,
        version,
        status: 'DRAFT',
        updatedAt: now,
        updatedBy: ctx.uid,
        ...(cur ? {} : { createdAt: now, createdBy: ctx.uid }),
      }, { merge: true });
      tx.create(ref.collection('versions').doc(String(version).padStart(4, '0')), { barangayId: input.barangayId, fiscalYear: input.fiscalYear, version, notes: input.notes, savedAt: now, savedBy: ctx.uid });
      audit.write({
        module: COL.nfsNarratives,
        recordId: id,
        action: cur ? 'EDIT' : 'CREATE',
        oldValue: cur ? { version: cur.version, titles: cur.notes.map((n) => n.title) } : null,
        newValue: { version, titles: input.notes.map((n) => n.title) },
        source: 'callable:saveNfsNarrative',
      });
      audit.commit();
      return { id, version };
    });
  },
);
