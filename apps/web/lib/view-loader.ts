'use client';

import { useCallback, useEffect, useState } from 'react';
import { subscribeToUpdates, type RealtimeStatus } from '@/lib/api-client';
import { createViewStore } from '@/lib/view-store.mjs';
import { viewKeysForEvent } from '@/lib/view-events.mjs';

type StoreView = { data: unknown; error: unknown; fetchedAt: number | null };
type ViewStore = {
  subscribe(key: string, listener: (view: StoreView) => void): () => void;
  load(key: string, fetcher: () => Promise<unknown>, options?: { staleMs?: number }): Promise<void>;
  refresh(key: string): Promise<void>;
  invalidate(keys: string[]): void;
  setPolling(key: string, ms: number | null): void;
  mountedKeys(): string[];
  read(key: string): StoreView | undefined;
};

const store = createViewStore() as unknown as ViewStore;

let socketUsers = 0;
let stopSocket: (() => void) | null = null;
let realtimeStatus: RealtimeStatus = 'connecting';
const statusListeners = new Set<(status: RealtimeStatus) => void>();

// The single WebSocket for every screen; it lives while at least one hook is mounted.
function retainSocket(): () => void {
  if (socketUsers++ === 0) {
    stopSocket = subscribeToUpdates(
      [],
      (frame) => {
        const mounted = store.mountedKeys();
        store.invalidate(frame ? (viewKeysForEvent(frame, mounted) as string[]) : mounted);
      },
      (status) => {
        realtimeStatus = status;
        for (const listener of [...statusListeners]) listener(status);
      },
      [],
    );
  }
  return () => {
    if (--socketUsers > 0) return;
    stopSocket?.();
    stopSocket = null;
    realtimeStatus = 'connecting';
  };
}

export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>(realtimeStatus);
  useEffect(() => {
    statusListeners.add(setStatus);
    setStatus(realtimeStatus);
    return () => {
      statusListeners.delete(setStatus);
    };
  }, []);
  return status;
}

export interface UseViewOptions<T> {
  staleMs?: number;
  /** Interval for data the server emits no event for; a function may return null to stop. */
  refreshMs?: number | null | ((data: T) => number | null);
}

export interface UseViewResult<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Load `fetcher()` under `key` through the shared cache; a null key does nothing. */
export function useView<T>(key: string | null, fetcher: () => Promise<T>, options: UseViewOptions<T> = {}): UseViewResult<T> {
  const [view, setView] = useState<StoreView | undefined>(() => (key === null ? undefined : store.read(key)));
  const { staleMs, refreshMs } = options;
  const data = view?.data as T | undefined;
  const intervalMs = typeof refreshMs === 'function' ? (data === undefined ? null : refreshMs(data)) : (refreshMs ?? null);

  useEffect(() => {
    if (key === null) {
      setView(undefined);
      return undefined;
    }
    const releaseSocket = retainSocket();
    setView(store.read(key));
    const unsubscribe = store.subscribe(key, setView);
    void store.load(key, () => fetcher().then((value) => ({ kind: 'fresh', value: { data: value, version: 0, etag: null } })), { staleMs });
    return () => {
      unsubscribe();
      releaseSocket();
    };
    // The fetcher closes over the inputs the key already identifies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, staleMs]);

  useEffect(() => {
    if (key !== null) store.setPolling(key, intervalMs);
  }, [key, intervalMs]);

  const refresh = useCallback(() => (key === null ? Promise.resolve() : store.refresh(key)), [key]);
  return {
    data,
    error: view?.error ?? null,
    loading: key !== null && (view === undefined || (view.fetchedAt === null && view.error === null)),
    refresh,
  };
}
