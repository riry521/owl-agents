'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ApiRequestError, getUploadLimits, uploadAttachment } from '@/lib/api-client';
import type { AttachmentTarget } from '@/lib/api-client';
import {
  attachmentIdsOf,
  blockedHintKey,
  checkFiles,
  draftReducer,
  emptyDraft,
  filesFromTransfer,
  isFileDrag,
  rejectionMessage,
  uploadFailureReason,
} from '@/lib/attachment-draft.mjs';
import { useLocale } from '@/lib/i18n';
import type { UploadLimits } from '@/lib/types';

export type DraftItem = {
  id: string;
  file: File;
  status: 'uploading' | 'ready' | 'quarantined' | 'failed';
  attachmentId?: string;
  reason?: { key: string; params: Record<string, string> };
};

let nextItemId = 0;

/** Pre-send attachment list for one composer: validates, uploads, retries and removes files. */
export function useAttachmentDraft(target: AttachmentTarget) {
  const { t } = useLocale();
  const [state, dispatch] = useReducer(draftReducer, emptyDraft) as [{ items: DraftItem[] }, (action: object) => void];
  const [notices, setNotices] = useState<string[]>([]);
  const itemsRef = useRef<DraftItem[]>([]);
  itemsRef.current = state.items;
  const controllers = useRef(new Map<string, AbortController>());

  const upload = useCallback((id: string, file: File) => {
    const controller = new AbortController();
    controllers.current.set(id, controller);
    uploadAttachment(target, file, { signal: controller.signal })
      .then((attachment) => dispatch({ type: 'uploaded', id, attachment }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError = error instanceof ApiRequestError ? error : null;
        dispatch({ type: 'failed', id, reason: uploadFailureReason(apiError, file) });
      })
      .finally(() => {
        if (controllers.current.get(id) === controller) controllers.current.delete(id);
      });
  }, [target.kind, target.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    let limits: UploadLimits | null = null;
    try {
      limits = await getUploadLimits();
    } catch {
      // Without limits the pre-check is skipped; the server answers 413 and the item shows the same reason.
    }
    let accepted = files;
    if (limits) {
      const checked = checkFiles(files, limits, itemsRef.current.length);
      accepted = checked.accepted;
      setNotices(checked.rejected.map((rejection: Parameters<typeof rejectionMessage>[0]) => rejectionMessage(rejection, limits as UploadLimits, t)));
    } else {
      setNotices([]);
    }
    const items = accepted.map((file) => ({ id: `attachment-${nextItemId++}`, file }));
    if (items.length === 0) return;
    // Count the new items at once: a second add resolving before the next render must see them against max_files.
    itemsRef.current = [...itemsRef.current, ...items.map(({ id, file }) => ({ id, file, status: 'uploading' as const }))];
    dispatch({ type: 'add', items });
    for (const item of items) upload(item.id, item.file);
  }, [t, upload]);

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    dispatch({ type: 'remove', id });
  }, []);

  const retry = useCallback((id: string) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status !== 'failed') return;
    dispatch({ type: 'retry', id });
    upload(id, item.file);
  }, [upload]);

  // With ids, only those items go (the ones just sent); files added while sending stay in the draft.
  const clear = useCallback((ids?: string[]) => {
    if (ids) {
      for (const id of ids) remove(id);
      setNotices([]);
      return;
    }
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    setNotices([]);
    dispatch({ type: 'clear' });
  }, [remove]);

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
  }, []);

  const hintKey: string | null = blockedHintKey(state.items);
  return {
    items: state.items,
    notices,
    dismissNotices: useCallback(() => setNotices([]), []),
    add,
    remove,
    retry,
    clear,
    attachmentIds: useMemo(() => attachmentIdsOf(state.items) as string[], [state.items]),
    hint: hintKey ? t(hintKey) : null,
  };
}

/** Drag-and-drop of files over a form. Text drags are ignored; nested elements do not make it flicker. */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };
  return {
    dragging,
    dropProps: {
      onDragEnter(event: DragEvent) {
        if (disabled || !isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver(event: DragEvent) {
        if (disabled || !isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
      },
      onDragLeave(event: DragEvent) {
        if (disabled || !isFileDrag(event.dataTransfer)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop(event: DragEvent) {
        if (disabled || !isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        reset();
        onFiles(filesFromTransfer(event.dataTransfer) as File[]);
      },
    },
  };
}
