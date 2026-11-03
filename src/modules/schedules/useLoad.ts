import { useCallback, useEffect, useState } from 'react';

/** Run an async loader when its deps change; `reload()` re-runs it (after a save). */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!load) return;
    let live = true;
    setLoading(true);
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
