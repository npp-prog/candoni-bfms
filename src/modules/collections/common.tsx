import { CASHBOOK_ACCOUNTS, collectionStatusLabel, formatAfSerial, type AccountableFormRecord, type BarangayId, type CollectionRecord, type DepositRecord, type SubsidiaryAccountDoc, type WithId } from '@bfms/shared';
import { SubsidiarySelect } from '../../components/forms';
import { StatusChip } from '../../components/ui';
import { useBarangay } from '../../contexts/BarangayContext';
import { useCollection } from '../../hooks/useCollection';

/** Shared bits of the Collections and Accountable Forms pages. */
export type Or = WithId<CollectionRecord>;
export type Dep = WithId<DepositRecord>;
export type AfSeries = WithId<AccountableFormRecord>;

/** An issued OR is stored as DRAFT (editable until reported); show it as ISSUED. */
export function OrStatus({ status }: { status: string }) {
  return status === 'DRAFT' ? <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-200">{collectionStatusLabel(status)}</span> : <StatusChip status={status} />;
}

/** Accountable officer / collector picker (subsidiary ledgers of Cash – In Local Treasury). */
export function OfficerSelect(p: { id?: string; barangayId: BarangayId; value: string | null; onChange(id: string | null): void; allowEmpty?: boolean; emptyLabel?: string; disabled?: boolean; required?: boolean }) {
  return <SubsidiarySelect {...p} accountCode={CASHBOOK_ACCOUNTS.CASH_IN_TREASURY} allowEmpty={p.allowEmpty ?? true} emptyLabel={p.emptyLabel ?? '— select officer —'} />;
}

export function useOfficers() {
  const { barangayId } = useBarangay();
  return useCollection<SubsidiaryAccountDoc>('subsidiaryAccounts', barangayId ? [['barangayId', '==', barangayId], ['accountCode', '==', CASHBOOK_ACCOUNTS.CASH_IN_TREASURY]] : null).rows;
}

/** ORs of the selected barangay and year (live). */
export function useOrs() {
  const { barangayId, fiscalYear } = useBarangay();
  return useCollection<CollectionRecord>('collections', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null, { limit: 2000 });
}

/** Every accountable-form series of the barangay (series outlive fiscal years). */
export function useAfSeries() {
  const { barangayId } = useBarangay();
  return useCollection<AccountableFormRecord>('accountableForms', barangayId ? [['barangayId', '==', barangayId]] : null);
}

/** The officer's active series to draw the next OR from: lowest unexhausted series first. */
export function nextOrFor(series: readonly AfSeries[], officerId: string | null): { form: AfSeries; next: string } | null {
  const f = series
    .filter((s) => s.accountableOfficerId === officerId && s.status === 'ACTIVE' && s.nextSerialNumber <= s.endingSerialNumber)
    .sort((a, b) => a.beginningSerialNumber - b.beginningSerialNumber)[0];
  return f ? { form: f, next: formatAfSerial(f.nextSerialNumber, f.serialWidth) } : null;
}

export const shortOfficer = (label: string | null | undefined) => (label ?? '').split(' — ')[0] ?? '';
