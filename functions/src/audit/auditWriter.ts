import { createHash } from 'node:crypto';
import { COL, type AuditAction, type AuditLogDoc, type BarangayScope } from '@bfms/shared';
import type { Transaction } from 'firebase-admin/firestore';
import { db, Timestamp } from '../lib/admin';
import type { CallerContext } from '../lib/context';

export interface AuditEntryInput {
  module: string;
  recordId: string;
  action: AuditAction;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  reason?: string | null;
  source: string;
}

const MAX_DIFF_BYTES = 20_000;

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (v instanceof Timestamp) return JSON.stringify(v.toDate().toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

function capped(v: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!v) return null;
  const s = canonical(v);
  if (s.length <= MAX_DIFF_BYTES) return v;
  return { truncated: true, sha256: createHash('sha256').update(s).digest('hex'), bytes: s.length };
}

/** Shallow diff of changed top-level fields (for EDIT audit records). */
export function diffFields(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const oldValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    const a = before?.[k];
    const b = after?.[k];
    if (canonical(a) !== canonical(b)) {
      oldValue[k] = a ?? null;
      newValue[k] = b ?? null;
    }
  }
  return { oldValue, newValue };
}

/**
 * Hash-chained, append-only audit writer bound to ONE Firestore transaction.
 * Firestore requires all reads before writes, so:
 *   const audit = await AuditWriter.begin(tx, ctx, barangayId)   // READ phase
 *   ... other reads ...
 *   audit.write({...})                                            // WRITE phase (any number)
 *   audit.commit()                                                // writes the chain head once
 * The audit record commits atomically with the change it describes.
 */
export class AuditWriter {
  private constructor(
    private readonly tx: Transaction,
    private readonly ctx: Pick<CallerContext, 'uid' | 'userName' | 'requestId' | 'rolesAt'>,
    private readonly barangayId: BarangayScope | 'SYSTEM',
    private prevHash: string | null,
    private readonly chainId: string,
  ) {}

  /**
   * @param chainId defaults to the barangay (one hash chain per barangay). High-frequency, low-risk
   *   events (LOGIN) pass a per-user chain so they never contend on a shared chain document.
   */
  static async begin(tx: Transaction, ctx: AuditWriter['ctx'], barangayId: BarangayScope | 'SYSTEM', chainId: string = barangayId) {
    const chain = await tx.get(db.collection(COL.auditChains).doc(chainId));
    return new AuditWriter(tx, ctx, barangayId, (chain.get('lastHash') as string | undefined) ?? null, chainId);
  }

  write(e: AuditEntryInput): string {
    const ref = db.collection(COL.auditLogs).doc();
    const now = Timestamp.now();
    const body: Omit<AuditLogDoc, 'hash'> = {
      timestamp: now,
      uid: this.ctx.uid,
      userName: this.ctx.userName,
      roles: this.barangayId === 'SYSTEM' ? [] : this.ctx.rolesAt(this.barangayId),
      barangayId: this.barangayId,
      module: e.module,
      recordId: e.recordId,
      action: e.action,
      oldValue: capped(e.oldValue),
      newValue: capped(e.newValue),
      reason: e.reason ?? null,
      source: e.source,
      requestId: this.ctx.requestId,
      prevHash: this.prevHash,
    };
    const hash = createHash('sha256').update(`${this.prevHash ?? ''}|${ref.id}|${canonical(body)}`).digest('hex');
    this.tx.create(ref, { ...body, hash });
    this.prevHash = hash;
    this.lastAuditId = ref.id;
    return ref.id;
  }

  private lastAuditId: string | null = null;

  /** Update the chain head (once per transaction). Must be called after the last write(). */
  commit(): void {
    if (!this.lastAuditId) return;
    this.tx.set(db.collection(COL.auditChains).doc(this.chainId), {
      lastHash: this.prevHash,
      lastAuditId: this.lastAuditId,
      updatedAt: Timestamp.now(),
    });
  }
}

/** Workflow history record (same transaction as the status change). */
export function writeWorkflowHistory(
  tx: Transaction,
  ctx: Pick<CallerContext, 'uid' | 'userName'>,
  e: { barangayId: string; module: string; recordId: string; fromStatus: string | null; toStatus: string; remarks?: string | null },
) {
  tx.create(db.collection(COL.workflowHistory).doc(), {
    ...e,
    remarks: e.remarks ?? null,
    actedBy: ctx.uid,
    actedByName: ctx.userName,
    actedAt: Timestamp.now(),
  });
}
