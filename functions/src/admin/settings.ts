import { COL } from '@bfms/shared';
import { z } from 'zod';
import { AuditWriter } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';

/**
 * Segregation of duties: by default the person who encoded a JEV cannot post it. Offices with a
 * single accounting person may allow self-posting; the change is audited with its reason.
 */
export const setAllowSelfPost = secureCallable(z.object({ allow: z.boolean(), reason: z.string().trim().min(10).max(500) }), async (input, ctx) => {
  ctx.require('admin.config.manage', 'ALL');
  const ref = db.collection(COL.systemSettings).doc('global');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const audit = await AuditWriter.begin(tx, ctx, 'ALL');
    tx.set(ref, { allowSelfPost: input.allow, updatedAt: Timestamp.now(), updatedBy: ctx.uid }, { merge: true });
    audit.write({ module: COL.systemSettings, recordId: 'global', action: 'EDIT', oldValue: { allowSelfPost: snap.get('allowSelfPost') ?? false }, newValue: { allowSelfPost: input.allow }, reason: input.reason, source: 'callable:setAllowSelfPost' });
    audit.commit();
  });
  return { allowSelfPost: input.allow };
});
