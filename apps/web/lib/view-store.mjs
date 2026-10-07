// キー付きキャッシュ（stale-while-revalidate）と、invalidate の束ね直しを持つ純 JS の読み込み係。
// DOM も React も使わず、時計とタイマーは引数で差し替えられる。

export const DEFAULT_COALESCE_MS = 300;
export const DEFAULT_COALESCE_MAX_WAIT_MS = 1500;
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
export const DEFAULT_STALE_MS = 30_000;
export const DEFAULT_REFRESH_MS = 5_000;

/**
 * fetcher は (etag) => Promise<{ kind: "fresh", value: { data, version, etag } } | { kind: "not_modified" }>。
 * listener には { data, etag, fetchedAt, error } を渡す。
 */
export function createViewStore({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  coalesceMs = DEFAULT_COALESCE_MS,
  coalesceMaxWaitMs = DEFAULT_COALESCE_MAX_WAIT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  staleMs: defaultStaleMs = DEFAULT_STALE_MS,
  refreshMs: defaultRefreshMs = DEFAULT_REFRESH_MS,
} = {}) {
  const entries = new Map();
  const dirty = new Map(); // key -> 最初に invalidate された時刻
  let coalesceTimer = null;

  function entryOf(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        data: undefined,
        etag: null,
        fetchedAt: null,
        error: null,
        stale: false,
        listeners: new Set(),
        fetcher: null,
        inflight: null,
        refetchAfter: false,
        pollMs: null,
        pollTimer: null,
        evictTimer: null,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  const snapshot = (entry) => ({ data: entry.data, etag: entry.etag, fetchedAt: entry.fetchedAt, error: entry.error });
  const hasState = (entry) => entry.fetchedAt !== null || entry.error !== null;
  const notify = (entry) => {
    const view = snapshot(entry);
    for (const listener of [...entry.listeners]) listener(view);
  };

  function fetchKey(key) {
    const entry = entries.get(key);
    if (!entry || !entry.fetcher) return Promise.resolve();
    if (entry.inflight) {
      entry.refetchAfter = true;
      return entry.inflight;
    }
    entry.stale = false;
    entry.inflight = Promise.resolve()
      .then(() => entry.fetcher(entry.etag))
      .then(
        (result) => {
          entry.fetchedAt = now();
          entry.error = null;
          if (result && result.kind === "fresh") {
            entry.data = result.value.data;
            entry.etag = result.value.etag ?? null;
          }
        },
        (error) => {
          entry.error = error;
        },
      )
      .then(() => {
        entry.inflight = null;
        notify(entry);
        if (entry.refetchAfter) {
          entry.refetchAfter = false;
          if (entry.listeners.size > 0) return fetchKey(key);
          entry.stale = true;
        }
        return undefined;
      });
    return entry.inflight;
  }

  function runDirty() {
    if (coalesceTimer !== null) {
      clearTimer(coalesceTimer);
      coalesceTimer = null;
    }
    const keys = [...dirty.keys()];
    dirty.clear();
    const fetches = [];
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry) continue;
      if (entry.listeners.size === 0) entry.stale = true; // 購読者が戻ったとき load が取り直す
      else fetches.push(fetchKey(key));
    }
    return Promise.all(fetches).then(() => undefined);
  }

  function invalidate(keys) {
    const at = now();
    for (const key of keys) if (!dirty.has(key)) dirty.set(key, at);
    if (dirty.size === 0) return;
    const oldest = Math.min(...dirty.values());
    const remaining = oldest + coalesceMaxWaitMs - at;
    if (remaining <= 0) {
      void runDirty();
      return;
    }
    if (coalesceTimer !== null) clearTimer(coalesceTimer);
    coalesceTimer = setTimer(() => {
      coalesceTimer = null;
      void runDirty();
    }, Math.min(coalesceMs, remaining));
  }

  function schedulePoll(key) {
    const entry = entries.get(key);
    if (!entry || entry.pollTimer !== null || entry.pollMs === null || entry.listeners.size === 0) return;
    entry.pollTimer = setTimer(() => {
      entry.pollTimer = null;
      if (entry.listeners.size === 0 || entry.pollMs === null) return;
      schedulePoll(key);
      void fetchKey(key);
    }, entry.pollMs);
  }

  function stopPoll(entry) {
    if (entry.pollTimer !== null) clearTimer(entry.pollTimer);
    entry.pollTimer = null;
  }

  function subscribe(key, listener) {
    const entry = entryOf(key);
    entry.listeners.add(listener);
    if (entry.evictTimer !== null) clearTimer(entry.evictTimer);
    entry.evictTimer = null;
    schedulePoll(key);
    if (hasState(entry)) listener(snapshot(entry));
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0) return;
      stopPoll(entry);
      entry.evictTimer = setTimer(() => {
        entry.evictTimer = null;
        if (entry.listeners.size === 0 && entries.get(key) === entry) entries.delete(key);
      }, cacheTtlMs);
    };
  }

  function load(key, fetcher, { staleMs = defaultStaleMs } = {}) {
    const entry = entryOf(key);
    entry.fetcher = fetcher;
    const fresh = entry.fetchedAt !== null && !entry.stale && now() - entry.fetchedAt < staleMs;
    return fresh ? Promise.resolve() : fetchKey(key);
  }

  return {
    read(key) {
      const entry = entries.get(key);
      return entry && hasState(entry) ? snapshot(entry) : undefined;
    },
    subscribe,
    load,
    invalidate,
    refresh: fetchKey,
    setPolling(key, ms = defaultRefreshMs) {
      const entry = entryOf(key);
      stopPoll(entry);
      entry.pollMs = ms;
      schedulePoll(key);
    },
    mountedKeys() {
      return [...entries].filter(([, entry]) => entry.listeners.size > 0).map(([key]) => key);
    },
    flush: runDirty,
  };
}
