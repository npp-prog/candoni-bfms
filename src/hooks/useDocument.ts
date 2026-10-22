import type { WithId } from '@bfms/shared';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { db } from '../services/firebase/app';

/** Live single document; `id` null skips. `data` is null while loading or when missing. */
export function useDocument<T>(col: string, id: string | null | undefined) {
  const [data, setData] = useState<WithId<T> | null>(null);
  const [loading, setLoading] = useState(!!id);
  useEffect(() => {
    if (!id) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    return onSnapshot(
      doc(db, col, id),
      (s) => {
        setData(s.exists() ? ({ ...(s.data() as T), id: s.id } as WithId<T>) : null);
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [col, id]);
  return { data, loading };
}
