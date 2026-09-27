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
        await api.unarchiveWork(work.id, work.state_version).catch(() => undefined);
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
      } catch {
        error = { id: `error-${++errorSeq}` };
        emit();
        return false;
      }
    }
    if (kind !== 'unarchive') {
      for (const work of works) hiddenIds.add(work.id);
      emit();
    }

    const results = await Promise.allSettled(works.map((work) => commitWork(work, kind)));
    let failed = false;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed = true;
        if (kind !== 'unarchive') hiddenIds.delete(works[index].id);
      }
    });
    if (failed) error = { id: `error-${++errorSeq}` };
    emit();
    return !failed;
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
