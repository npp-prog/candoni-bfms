import { formatPesos } from '../accounting/money';
import type { AccountBalanceDoc, JournalLineDoc } from '../types/accounting';
import type { Centavos, IsoDate } from '../types/common';
import type { ReportContext } from './context';
import type { Filter, WithId } from './datasource';

/** Posted journal lines of the barangay/fiscal year (collection group `lines`), oldest first. */
export async function postedLines(ctx: ReportContext, extra: readonly Filter[] = []): Promise<WithId<JournalLineDoc>[]> {
  const rows = await ctx.ds.listGroup<JournalLineDoc>('lines', [
    ['barangayId', '==', ctx.params.barangayId],
    ['fiscalYear', '==', ctx.params.fiscalYear],
    ['posted', '==', true],
    ...extra,
  ]);
  return rows.sort((a, b) => a.jevDate.localeCompare(b.jevDate) || (a.jevNumber ?? '').localeCompare(b.jevNumber ?? '') || a.lineNo - b.lineNo);
}

/** Period movement aggregates (accountBalances) for a fiscal year. */
export async function periodBalances(ctx: ReportContext, fiscalYear = ctx.params.fiscalYear): Promise<WithId<AccountBalanceDoc>[]> {
  return ctx.ds.list<AccountBalanceDoc>('accountBalances', [
    ['barangayId', '==', ctx.params.barangayId],
    ['fiscalYear', '==', fiscalYear],
  ]);
}

export function inRange(date: IsoDate | null | undefined, range: { from: IsoDate; to: IsoDate }): boolean {
  return !!date && date >= range.from && date <= range.to;
}

/** "1-01-02-010 Cash in Bank - Local Currency, Current Account" */
export async function accountTitle(ctx: ReportContext, code: string): Promise<string> {
  const a = (await ctx.accounts()).get(code);
  return a ? a.accountName : code;
}

/** Text form of an amount for paragraphs/meta (₱1,234.56). */
export function peso(v: Centavos | number): string {
  return formatPesos(v as Centavos, { symbol: true });
}

/** Load documents of a collection for the barangay and fiscal year, filtered client-side by a date field. */
export async function docsInRange<T extends Record<string, unknown>>(
  ctx: ReportContext,
  collection: string,
  dateField: string,
  extra: readonly Filter[] = [],
  range = ctx.range,
): Promise<WithId<T>[]> {
  const rows = await ctx.ds.list<T>(collection, [['barangayId', '==', ctx.params.barangayId], ['fiscalYear', '==', ctx.params.fiscalYear], ...extra]);
  return rows
    .filter((r) => inRange(r[dateField] as string | undefined, range))
    .sort((a, b) => String(a[dateField]).localeCompare(String(b[dateField])));
}

/** Statuses that count as "official" (excludes drafts and voided/cancelled records). */
export const OFFICIAL_STATUSES = ['SUBMITTED', 'RESUBMITTED', 'FOR_REVIEW', 'APPROVED', 'ACCEPTED', 'POSTED', 'CERTIFIED', 'ISSUED', 'RELEASED', 'CLEARED', 'ACTIVE'] as const;

export function isOfficial(status: string | undefined): boolean {
  return !!status && (OFFICIAL_STATUSES as readonly string[]).includes(status);
}
