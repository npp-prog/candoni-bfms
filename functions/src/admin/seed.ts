import {
  BARANGAYS,
  COL,
  MUNICIPALITY,
  PROVINCE,
  REPORT_DEFINITIONS,
  ROLE_CODES,
  ROLES,
  buildChartOfAccounts,
  permissionsForRole,
} from '@bfms/shared';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { AuditWriter } from '../audit/auditWriter';
import { db, Timestamp } from '../lib/admin';
import { secureCallable } from '../lib/callable';

/**
 * Idempotent reference-data seed. By default only CREATES missing documents, so edits made by
 * Municipal Accounting (e.g. COA names, deadlines) are never overwritten. `overwrite` replaces
 * roles/report definitions only (never COA — COA changes go through coa.manage UI).
 */
export const seedReferenceData = secureCallable(
  z.object({ overwriteCatalogs: z.boolean().default(false) }),
  async (input, ctx) => {
    if (!ctx.can('admin.config.manage', 'ALL')) throw new HttpsError('permission-denied', 'Requires admin.config.manage at ALL.');
    const now = Timestamp.now();
    const counts: Record<string, number> = {};

    async function createMissing(col: string, docs: Array<{ id: string; data: Record<string, unknown> }>, overwrite = false) {
      let created = 0;
      for (let i = 0; i < docs.length; i += 400) {
        const chunk = docs.slice(i, i + 400);
        const refs = chunk.map((d) => db.collection(col).doc(d.id));
        const snaps = await db.getAll(...refs);
        const batch = db.batch();
        snaps.forEach((s, j) => {
          if (!s.exists || overwrite) {
            batch.set(refs[j]!, chunk[j]!.data);
            created++;
          }
        });
        await batch.commit();
      }
      counts[col] = created;
    }

    await createMissing(
      COL.barangays,
      BARANGAYS.map((b) => ({
        id: b.barangayId,
        data: {
          ...b,
          municipality: MUNICIPALITY,
          province: PROVINCE,
          active: true,
          punongBarangay: null,
          barangayTreasurer: null,
          appropriationChairperson: null,
          contactInformation: {},
          bankAccounts: [],
          defaultSignatories: {},
          createdAt: now,
          updatedAt: now,
        },
      })),
    );

    await createMissing(
      COL.roles,
      ROLE_CODES.map((r) => ({
        id: r,
        data: {
          roleId: r,
          label: ROLES[r].label,
          description: '',
          claimCode: ROLES[r].claim,
          allowedScopes: ROLES[r].scopes.map((s) => (s === 'ALL' ? 'ALL' : 'BARANGAY')),
          permissions: permissionsForRole(r),
          active: true,
        },
      })),
      input.overwriteCatalogs,
    );

    await createMissing(
      COL.chartOfAccounts,
      buildChartOfAccounts().map((a) => ({ id: a.accountCode, data: { ...a } })),
    );

    await createMissing(COL.funds, [
      { id: 'GF', data: { fundId: 'GF', barangayId: 'ALL', fundType: 'GENERAL_FUND', fundCode: 'GF', fundName: 'General Fund', active: true } },
    ]);

    await createMissing(
      COL.reportDefinitions,
      REPORT_DEFINITIONS.map((r) => ({ id: r.reportCode, data: { ...r } })),
      input.overwriteCatalogs,
    );

    await createMissing(
      COL.complianceRequirements,
      REPORT_DEFINITIONS.filter((r) => r.inMonthlyPackage || r.frequency === 'ANNUAL').map((r) => ({
        id: r.reportCode,
        data: {
          reportCode: r.reportCode,
          frequency: r.frequency,
          deadlineRule: r.deadlineRule,
          responsibleRole: r.preparedByRole,
          appliesTo: 'ALL',
          effectiveFrom: '2026-01',
          effectiveTo: null,
          active: true,
        },
      })),
    );

    await createMissing(COL.systemSettings, [
      {
        id: 'global',
        data: { allowSelfPost: false, maxAttachmentMb: 25, defaultPageSize: 25, timeZone: 'Asia/Manila', updatedAt: now },
      },
      {
        id: 'aging',
        data: {
          buckets: [
            { maxDays: 30, label: '0-30 days' },
            { maxDays: 60, label: '31-60 days' },
            { maxDays: 90, label: '61-90 days' },
            { maxDays: 180, label: '91-180 days' },
            { maxDays: 365, label: '181-365 days' },
            { maxDays: 1_000_000, label: 'Over 1 year' },
          ],
          liquidationDueDays: { PAYROLL: 5, OFFICIAL_TRAVEL: 30, SPECIAL_PURPOSE: 20, PETTY_CASH: 365, OTHER_AUTHORIZED: 30 },
          liquidationDueDaysConfirmed: false,
          updatedAt: now,
        },
      },
    ]);

    await db.runTransaction(async (tx) => {
      const audit = await AuditWriter.begin(tx, ctx, 'SYSTEM');
      audit.write({ module: 'systemSettings', recordId: 'seed', action: 'SEED', newValue: counts, source: 'callable:seedReferenceData' });
      audit.commit();
    });
    return { created: counts };
  },
  { timeoutSeconds: 300, memory: '512MiB' },
);
