import { useCallback, useSyncExternalStore } from "react";
import { ApiError } from "../api/errors";

/**
 * Minimal query cache with invalidation — no external dependency. Every
 * query gets a stable key; SSE handlers and mutations invalidate key
 * prefixes, subscribed components re-render and refetch while stale data
 * stays visible. A failing health check therefore never wipes the last
 * known view (docs/frontend-backend-integration.md §9.1).
 */

interface QueryEntry<T = unknown> {
  key: string;
  data?: T;
  error?: ApiError;
  loading: boolean;
  loadedAt: number;
  stale: boolean;
  inFlight: boolean;
  subscribers: Set<() => void>;
}

const EMPTY = { loading: false, loadedAt: 0, stale: true, inFlight: false };
const EMPTY_SNAPSHOT: QueryEntry = { key: "", ...EMPTY, subscribers: new Set() };

class QueryCache {
  private entries = new Map<string, QueryEntry>();

  entry(key: string): QueryEntry | undefined {
    return this.entries.get(key);
  }

  subscribe(key: string, callback: () => void): () => void {
    const entry = this.ensure(key);
    entry.subscribers.add(callback);
    return () => {
      entry.subscribers.delete(callback);
    };
  }

  private ensure(key: string): QueryEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, ...EMPTY, subscribers: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private replace(key: string, patch: Partial<QueryEntry>) {
    const next = { ...this.ensure(key), ...patch };
    this.entries.set(key, next);
    next.subscribers.forEach((callback) => callback());
  }

  fetch<T>(key: string, fetcher: () => Promise<T>, { force = false } = {}): void {
    const entry = this.ensure(key);
    if (entry.inFlight) return;
    if (!force && !entry.stale && entry.loadedAt > 0) return;

    this.replace(key, { inFlight: true, loading: true, stale: false });
    void (async () => {
      try {
        const data = await fetcher();
        this.replace(key, { data, error: undefined, loading: false, loadedAt: Date.now(), inFlight: false });
      } catch (error) {
        const apiError = error instanceof ApiError ? error : new ApiError(0, "NETWORK_ERROR", "网络错误或服务不可用。");
        // Keep previous data on error (stale-while-error).
        this.replace(key, { error: apiError, loading: false, inFlight: false });
      }
    })();
  }

  /** Mark matching keys stale; subscribed components refetch on re-render. */
  invalidate(prefix: string) {
    for (const key of this.entries.keys()) {
      if (prefix !== "*" && !key.startsWith(prefix)) continue;
      this.replace(key, { stale: true });
    }
  }
}

export const queryCache = new QueryCache();

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  loadedAt: number;
  refetch: () => void;
}

export function useQuery<T>(key: string[], fetcher: () => Promise<T>, options: { enabled?: boolean } = {}): QueryResult<T> {
  const cacheKey = key.join("::");
  const enabled = options.enabled ?? true;

  const subscribe = useCallback(
    (callback: () => void) => queryCache.subscribe(cacheKey, callback),
    [cacheKey],
  );
  const getSnapshot = useCallback(() => queryCache.entry(cacheKey) ?? EMPTY_SNAPSHOT, [cacheKey]);

  const entry = useSyncExternalStore(subscribe, getSnapshot) as QueryEntry<T>;

  const refetch = useCallback(() => {
    queryCache.fetch(cacheKey, fetcher, { force: true });
  }, [cacheKey, fetcher]);

  if (enabled && (entry.stale || (entry.loading && !entry.inFlight)) && !entry.inFlight) {
    // Schedule after render so useSyncExternalStore sees a stable snapshot.
    queueMicrotask(() => queryCache.fetch(cacheKey, fetcher));
  }

  return {
    data: entry.data,
    error: entry.error,
    loading: entry.loading && entry.loadedAt === 0,
    loadedAt: entry.loadedAt,
    refetch,
  };
}
