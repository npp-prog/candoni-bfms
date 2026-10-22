import type { Filter, OrderBy, WithId } from '@bfms/shared';
import { collection, limit as qLimit, onSnapshot, orderBy as qOrderBy, query, where, type QueryConstraint } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../services/firebase/app';

/**
 * Live list of a collection (onSnapshot), for module registers scoped to one barangay and year.
 * Pass `null` filters to skip (e.g. no barangay selected). Results are capped by `limit` (default 500).
 * Every barangay-owned query MUST include ['barangayId', '==', id] or Security Rules reject it.
 */
export function useCollection<T>(col: string, filters: readonly Filter[] | null, opts: { orderBy?: readonly OrderBy[]; limit?: number } = {}) {
  const [rows, setRows] = useState<WithId<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const key = useMemo(() => JSON.stringify([col, filters, opts.orderBy, opts.limit]), [col, filters, opts.orderBy, opts.limit]);

  useEffect(() => {
    if (!filters) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const c: QueryConstraint[] = filters.map(([f, op, v]) => where(f, op, v));
    (opts.orderBy ?? []).forEach(([f, dir]) => c.push(qOrderBy(f, dir ?? 'asc')));
    c.push(qLimit(opts.limit ?? 500));
    return onSnapshot(
      query(collection(db, col), ...c),
      (s) => {
        setRows(s.docs.map((d) => ({ ...(d.data() as T), id: d.id }) as WithId<T>));
        setLoading(false);
        setError(null);
      },
      (e) => {
        setError(e);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { rows, loading, error };
}
