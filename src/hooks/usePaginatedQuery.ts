import {
  getDocs,
  limit,
  query,
  startAfter,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';

/**
 * Cursor-based Firestore pagination (Section LXXXIII). Never downloads the whole collection:
 * fetches pageSize + 1 to know whether a next page exists; keeps a cursor stack for "Previous".
 */
export function usePaginatedQuery<T = DocumentData>(base: Query | null, pageSize: 25 | 50 | 100 = 25, deps: unknown[] = []) {
  const [rows, setRows] = useState<Array<T & { id: string }>>([]);
  const [cursors, setCursors] = useState<QueryDocumentSnapshot[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (after: QueryDocumentSnapshot | null) => {
      if (!base) return;
      setLoading(true);
      setError(null);
      try {
        const q = after ? query(base, startAfter(after), limit(pageSize + 1)) : query(base, limit(pageSize + 1));
        const snap = await getDocs(q);
        const docs = snap.docs.slice(0, pageSize);
        setHasNext(snap.docs.length > pageSize);
        setRows(docs.map((d) => ({ id: d.id, ...(d.data() as T) })));
        return docs[docs.length - 1] ?? null;
      } catch (e) {
        setError(e as Error);
        return null;
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, pageSize, ...deps],
  );

  useEffect(() => {
    setCursors([]);
    void load(null).then((last) => last && setCursors([last]));
  }, [load]);

  const next = async () => {
    const last = cursors[cursors.length - 1];
    if (!last || !hasNext) return;
    const newLast = await load(last);
    if (newLast) setCursors((c) => [...c, newLast]);
  };
  const prev = async () => {
    if (cursors.length <= 1) return;
    const stack = cursors.slice(0, -1);
    const after = stack.length >= 2 ? stack[stack.length - 2]! : null;
    await load(after);
    setCursors(stack);
  };
  return { rows, loading, error, hasNext, hasPrev: cursors.length > 1, page: cursors.length, next, prev, reload: () => load(null) };
}
