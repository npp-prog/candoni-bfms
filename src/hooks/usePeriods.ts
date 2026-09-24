import type { AccountingPeriodDoc, BarangayId } from '@bfms/shared';
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { db } from '../services/firebase/app';

export function usePeriods(barangayId: BarangayId | null, fiscalYear: number) {
  const [periods, setPeriods] = useState<Array<AccountingPeriodDoc & { id: string }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!barangayId) return;
    setLoading(true);
    const q = query(collection(db, 'accountingPeriods'), where('barangayId', '==', barangayId), where('fiscalYear', '==', fiscalYear), orderBy('month'));
    return onSnapshot(
      q,
      (s) => {
        setPeriods(s.docs.map((d) => ({ id: d.id, ...(d.data() as AccountingPeriodDoc) })));
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [barangayId, fiscalYear]);
  return { periods, loading };
}
