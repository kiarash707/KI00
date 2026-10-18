import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[] = []
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loaderRef
      .current()
      .then((result) => {
        if (cancelled || !mounted.current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || !mounted.current) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled && mounted.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}
