'use client';

import { useSyncExternalStore } from 'react';
import { archiveWork, deleteWork, getWorkBranchStatus, unarchiveWork } from '@/lib/api-client';
import type { WorkSummary } from '@/lib/types';
import type { TFunction } from '@/lib/i18n';

export type RemovalKind = 'delete' | 'archive' | 'unarchive';

export type RemovableWork = Pick<WorkSummary, 'id' | 'title' | 'state_version' | 'archived_at'>;

/** A transient error shown after a failed archive/unarchive/delete call. */
export interface RemovalErrorMessage {
  id: string;
  /** What the failed calls reported (deduplicated), so the toast can show the cause. */
  detail?: string;
}

/**
 * The server's explanation (which paths remain) when a delete stopped on cleanup, else null.
 * ApiRequestError keeps only the code in `message`, so the reason is read from `rawMessage`.
 */
export function cleanupFailureReason(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, rawMessage } = error as { code?: unknown; rawMessage?: unknown };
  return code === 'worktree_cleanup_failed' && typeof rawMessage === 'string' && rawMessage ? rawMessage : null;
}

/** Why a cancel left its worktree behind (Core's message and the path), or null when cleanup succeeded or was not reported. */
export function cancelCleanupFailure(data: unknown): string | null {
  const cleanup = (data as { worktree_cleanup?: { ok?: unknown; message?: unknown; details?: { path?: unknown } } } | null)?.worktree_cleanup;
  if (!cleanup || cleanup.ok !== false) return null;
  const message = typeof cleanup.message === 'string' ? cleanup.message : '';
  const path = typeof cleanup.details?.path === 'string' ? cleanup.details.path : '';
  return [message, path].filter(Boolean).join(' ') || null;
}

function describeFailure(reason: unknown): string {
  if (reason instanceof AggregateError) return reason.errors.map(describeFailure).join(' / ');
  const cleanup = cleanupFailureReason(reason);
  if (cleanup) return cleanup;
  return reason instanceof Error ? reason.message : String(reason);
}

export interface WorkRemovalSnapshot {
  hiddenIds: ReadonlySet<string>;
  error: RemovalErrorMessage | null;
}

export interface RemovalApi {
  archiveWork: (id: string, version: number) => Promise<unknown>;
  unarchiveWork: (id: string, version: number) => Promise<unknown>;
  deleteWork: (id: string, version: number) => Promise<unknown>;
}

export interface WorkRemovalStoreOptions {
  api?: RemovalApi;
}

export interface WorkRemovalStore {
  removeWorks: (works: RemovableWork[], kind: RemovalKind, confirmDelete?: () => Promise<boolean> | boolean) => Promise<boolean>;
  dismissError: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => WorkRemovalSnapshot;
  getServerSnapshot: () => WorkRemovalSnapshot;
  isHidden: (id: string) => boolean;
  /** Stops hiding a Work, e.g. once a Board refresh already reflects its new archive state. */
  reveal: (id: string) => void;
}

const EMPTY_SNAPSHOT: WorkRemovalSnapshot = { hiddenIds: new Set(), error: null };

/** Builds an independent, fully injectable removal store (real work happens through `api`). */
export function createWorkRemovalStore(options: WorkRemovalStoreOptions = {}): WorkRemovalStore {
  const api: RemovalApi = options.api ?? { archiveWork, unarchiveWork, deleteWork };

  const hiddenIds = new Set<string>();
  const listeners = new Set<() => void>();
  let error: RemovalErrorMessage | null = null;
  let errorSeq = 0;
  let snapshot = takeSnapshot();

  function takeSnapshot(): WorkRemovalSnapshot {
    return { hiddenIds: new Set(hiddenIds), error };
  }

  function emit() {
    snapshot = takeSnapshot();
    for (const listener of listeners) listener();
  }

  async function commitWork(work: RemovableWork, kind: RemovalKind) {
    if (kind === 'delete') {
      if (work.archived_at) {
        await api.deleteWork(work.id, work.state_version);
        return;
      }
      await api.archiveWork(work.id, work.state_version);
      try {
        await api.deleteWork(work.id, work.state_version);
      } catch (error) {
        // Put the Work back where it was, so a failed delete does not leave it hidden in the archive.
        try {
          await api.unarchiveWork(work.id, work.state_version);
        } catch (rollbackError) {
          // The Work stays hidden in the archive, so the caller has to see both failures.
          throw new AggregateError([error, rollbackError], 'Delete failed and the Work could not be unarchived');
        }
        throw error;
      }
    } else if (kind === 'archive') {
      await api.archiveWork(work.id, work.state_version);
    } else {
      await api.unarchiveWork(work.id, work.state_version);
    }
  }

  /** Hides the works (unless unarchiving) and runs the API calls right away. */
  async function removeWorks(
    works: RemovableWork[],
    kind: RemovalKind,
    confirmDelete?: () => Promise<boolean> | boolean,
  ): Promise<boolean> {
    if (works.length === 0) return false;
    if (kind === 'delete' && confirmDelete) {
      try {
        if (!await confirmDelete()) return false;
      } catch (confirmError) {
        console.error('[Owl] Work delete confirmation failed', confirmError);
        error = { id: `error-${++errorSeq}`, detail: describeFailure(confirmError) };
        emit();
        return false;
      }
    }
    if (kind !== 'unarchive') {
      for (const work of works) hiddenIds.add(work.id);
      emit();
    }

    const results = await Promise.allSettled(works.map((work) => commitWork(work, kind)));
    const details = new Set<string>();
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        details.add(describeFailure(result.reason));
        console.error('[Owl] Work removal failed', kind, works[index].id, result.reason);
        if (kind !== 'unarchive') hiddenIds.delete(works[index].id);
      }
    });
    if (details.size > 0) error = { id: `error-${++errorSeq}`, detail: [...details].join(' / ') };
    emit();
    return details.size === 0;
  }

  function dismissError() {
    if (error) {
      error = null;
      emit();
    }
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getSnapshot() {
    return snapshot;
  }

  function getServerSnapshot() {
    return EMPTY_SNAPSHOT;
  }

  function isHidden(id: string) {
    return hiddenIds.has(id);
  }

  function reveal(id: string) {
    if (hiddenIds.delete(id)) emit();
  }

  return { removeWorks, dismissError, subscribe, getSnapshot, getServerSnapshot, isHidden, reveal };
}

/** The store instance the app actually uses; components read it through `useWorkRemovals`. */
export const defaultWorkRemovalStore = createWorkRemovalStore();

export function removeWorks(
  works: RemovableWork[],
  kind: RemovalKind,
  confirmDelete?: () => Promise<boolean> | boolean,
): Promise<boolean> {
  return defaultWorkRemovalStore.removeWorks(works, kind, confirmDelete);
}

/**
 * Checks branch status before prompting, so ordinary deletions keep their
 * one-tap flow. A status that could not be read counts as possibly unmerged.
 */
export async function confirmDeleteIfUnmerged(works: RemovableWork[], t: TFunction): Promise<boolean> {
  const statuses = await Promise.allSettled(works.map((work) => getWorkBranchStatus(work.id)));
  const unmergedCount = statuses.filter((status) => status.status === 'fulfilled' && status.value === 'present').length;
  const unknownCount = statuses.filter((status) => status.status === 'rejected' || status.value === 'unknown').length;
  if (unmergedCount === 0 && unknownCount === 0) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  const messages: string[] = [];
  if (unmergedCount === 1) messages.push(t('work.deleteUnmergedConfirm'));
  if (unmergedCount > 1) messages.push(t('work.deleteMultipleUnmergedConfirm', { count: String(unmergedCount) }));
  if (unknownCount > 0) messages.push(t('work.deleteUnmergedUnknownConfirm', { count: String(unknownCount) }));
  return window.confirm(messages.join('\n'));
}

export function revealWork(id: string): void {
  defaultWorkRemovalStore.reveal(id);
}

export function dismissRemovalError(): void {
  defaultWorkRemovalStore.dismissError();
}

export function useWorkRemovals(): WorkRemovalSnapshot {
  return useSyncExternalStore(
    defaultWorkRemovalStore.subscribe,
    defaultWorkRemovalStore.getSnapshot,
    defaultWorkRemovalStore.getServerSnapshot,
  );
}
