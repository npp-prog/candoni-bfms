import type { AccountBalanceDoc, BarangayId } from '@bfms/shared';
import { useCollection } from '../../hooks/useCollection';

/** Live period balances (accountBalances) of one barangay and year — at most ~274 accounts × 14 periods plus SL rows. */
export function useBalances(barangayId: BarangayId | null, fiscalYear: number) {
  return useCollection<AccountBalanceDoc>('accountBalances', barangayId ? [['barangayId', '==', barangayId], ['fiscalYear', '==', fiscalYear]] : null, { limit: 10000 });
}
