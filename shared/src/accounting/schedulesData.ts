import type { AccountBalanceDoc, JournalEntryDoc, JournalLineDoc } from '../types/accounting';
import type { LegacyCashAdvanceDoc, PpeScheduleDoc } from '../types/accountingSchedules';
import type { SubsidiaryAccountDoc } from '../types/coa';
import type { BarangayId, IsoDate } from '../types/common';
import type { DataSource, WithId } from '../reports/datasource';
import { normalizeAgingSettings } from './cashAdvancesLedger';
import {
  buildCaSchedule,
  computePpeSchedule,
  isCaScheduleAccount,
  isDepreciablePpeAccount,
  mergePpeRows,
  ppeAccountsWithBalance,
  ppeGlFigures,
  type CaLedgerLine,
  type CaOfficerInfo,
  type CaSchedule,
  type PpeComputedRow,
} from './schedules';

/**
 * Loaders shared by the report builders (server snapshot + browser) and the schedule pages.
 * Every query carries barangayId (Security Rules) and uses the existing `lines` collection-group
 * index (barangayId, fiscalYear, posted, accountCode, …).
 */

export async function loadCaScheduleInputs(ds: DataSource, barangayId: BarangayId, fiscalYear: number) {
  const [legacy, rawLines, sls, aging] = await Promise.all([
    ds.list<LegacyCashAdvanceDoc>('legacyCashAdvances', [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]]),
    ds.listGroup<JournalLineDoc>('lines', [
      ['barangayId', '==', barangayId],
      ['fiscalYear', '==', fiscalYear],
      ['posted', '==', true],
      ['accountCode', '>=', '1-03-03-010'],
      ['accountCode', '<=', '1-03-04-099'],
    ]),
    ds.list<SubsidiaryAccountDoc>('subsidiaryAccounts', [['barangayId', '==', barangayId]]),
    ds.get<unknown>('systemSettings', 'aging').catch(() => null),
  ]);
  const caLines = rawLines.filter((l) => isCaScheduleAccount(l.accountCode));
  const headers = new Map<string, WithId<JournalEntryDoc> | null>();
  await Promise.all([...new Set(caLines.map((l) => l.jevId))].map(async (id) => headers.set(id, await ds.get<JournalEntryDoc>('journalEntries', id).catch(() => null))));
  const lines: CaLedgerLine[] = caLines.map((l) => ({
    jevId: l.jevId,
    jevNumber: l.jevNumber,
    jevDate: l.jevDate,
    entryType: l.entryType,
    accountCode: l.accountCode,
    subsidiaryId: l.subsidiaryId,
    debit: l.debit,
    credit: l.credit,
    primaryReference: l.primaryReference,
    secondaryReference: l.secondaryReference,
    lineDescription: l.lineDescription ?? '',
    particulars: headers.get(l.jevId)?.particulars ?? '',
    payeeName: l.payeeName ?? headers.get(l.jevId)?.payeeName ?? null,
  }));
  const officers = new Map<string, CaOfficerInfo>(sls.filter((s) => isCaScheduleAccount(s.accountCode)).map((s) => [s.id, { name: s.subsidiaryName, code: s.subsidiaryCode }]));
  return { legacy, lines, officers, buckets: normalizeAgingSettings(aging).buckets, subsidiaries: sls };
}

export async function loadCaSchedule(ds: DataSource, barangayId: BarangayId, fiscalYear: number, asOf: IsoDate): Promise<CaSchedule & { legacyDocs: WithId<LegacyCashAdvanceDoc>[] }> {
  const x = await loadCaScheduleInputs(ds, barangayId, fiscalYear);
  const schedule = buildCaSchedule({ fiscalYear, asOf, legacy: x.legacy.map((l) => ({ ...l, id: l.id })), lines: x.lines, officers: x.officers, buckets: x.buckets });
  return { ...schedule, legacyDocs: x.legacy };
}

export interface PpeScheduleView {
  doc: WithId<PpeScheduleDoc> | null;
  rows: PpeComputedRow[];
  /** GL depreciation expense (5-04-01-xxx, debit − credit) recorded in the year, per account. */
  expenseRecorded: Map<string, number>;
  balances: WithId<AccountBalanceDoc>[];
}

/**
 * The PPE schedule of a fiscal year. `month` null = the year (cost at Dec 31, accumulated brought
 * in = opening balance); a month = that month's run (cost at month end, accumulated before = months
 * before it).
 */
export async function loadPpeSchedule(ds: DataSource, barangayId: BarangayId, fiscalYear: number, month: number | null = null): Promise<PpeScheduleView> {
  const [doc, balances] = await Promise.all([
    ds.get<PpeScheduleDoc>('ppeSchedules', `${barangayId}_${fiscalYear}`),
    ds.list<AccountBalanceDoc>('accountBalances', [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]]),
  ]);
  const ppe = balances.filter((b) => b.accountCode.startsWith('1-07-') || b.accountCode.startsWith('5-04-01-'));
  const toMonth = month ?? 12;
  const rows = mergePpeRows(doc?.rows, ppeAccountsWithBalance(ppe, toMonth)).filter((r) => isDepreciablePpeAccount(r.accountCode));
  const gl = ppeGlFigures(rows, ppe, { costMonth: toMonth, fromMonth: month ?? 1, toMonth });
  const expenseRecorded = new Map<string, number>();
  for (const b of ppe)
    if (b.subsidiaryId === null && b.accountCode.startsWith('5-04-01-') && b.month >= 1 && b.month <= toMonth && (month === null || b.month === month))
      expenseRecorded.set(b.accountCode, (expenseRecorded.get(b.accountCode) ?? 0) + b.debit - b.credit);
  return { doc, rows: computePpeSchedule(rows, gl, month ? 'MONTH' : 'YEAR'), expenseRecorded, balances };
}
