import type { ChartOfAccountDoc } from '@bfms/shared';
import { collection, getDocs, orderBy, query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { db } from '../services/firebase/app';

let cache: Map<string, ChartOfAccountDoc> | null = null;

/** Reference data (~274 docs) cached for the session — Section CI "cached reference data". */
export function useChartOfAccounts() {
  const [accounts, setAccounts] = useState<Map<string, ChartOfAccountDoc> | null>(cache);
  useEffect(() => {
    if (cache) return;
    void getDocs(query(collection(db, 'chartOfAccounts'), orderBy('sortOrder'))).then((s) => {
      cache = new Map(s.docs.map((d) => [d.id, d.data() as ChartOfAccountDoc]));
      setAccounts(cache);
    });
  }, []);
  return accounts;
}
