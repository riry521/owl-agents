/** Pure helpers for the pre-send attachment list shared by the Advisor and Work composers. */

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** "72.4 MB", "50 MB": one decimal, dropped when it is zero. */
export function formatBytes(bytes) {
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${UNITS[unit]}`;
}

/**
 * Split files into the ones to upload and the ones refused before upload.
 * Limits come from getUploadLimits(); nothing is hardcoded here.
 *
 * @param {File[]} files
 * @param {{ max_bytes: number, max_files: number }} limits
 * @param {number} currentCount items already in the list
 * @returns {{ accepted: File[], rejected: { file: File, reason: 'too_large' | 'too_many' }[] }}
 */
export function checkFiles(files, limits, currentCount) {
  const accepted = [];
  const rejected = [];
  for (const file of files) {
    if (file.size > limits.max_bytes) rejected.push({ file, reason: 'too_large' });
    else if (currentCount + accepted.length >= limits.max_files) rejected.push({ file, reason: 'too_many' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** The user-facing sentence for a refused file. */
export function rejectionMessage(rejection, limits, t) {
  const name = rejection.file.name;
  if (rejection.reason === 'too_large') {
    return t('attachments.tooLarge', { name, size: formatBytes(rejection.file.size), max: formatBytes(limits.max_bytes) });
  }
  return t('attachments.tooMany', { name, max: String(limits.max_files) });
}

/**
 * Map an upload failure to an i18n key plus params, so the tray can translate it.
 * A 413 carries details.max_bytes; a filename rejection is validation_error on field "filename".
 */
export function uploadFailureReason(error, file) {
  if (error?.code === 'upload_too_large') {
    const max = Number(error.details?.max_bytes);
    return { key: 'attachments.tooLarge', params: { name: file.name, size: formatBytes(file.size), max: Number.isFinite(max) ? formatBytes(max) : '' } };
  }
  if (error?.code === 'validation_error' && error.details?.field === 'filename') {
    return { key: 'attachments.badName', params: {} };
  }
  return { key: 'attachments.uploadFailed', params: {} };
}

export const emptyDraft = Object.freeze({ items: [] });

/**
 * Item states: uploading | ready | quarantined | failed.
 * Actions: add {items:[{id,file}]}, uploaded {id,attachment}, failed {id,reason}, retry {id}, remove {id}, clear.
 * Results for ids no longer in the list (removed meanwhile) are dropped.
 */
export function draftReducer(state, action) {
  switch (action.type) {
    case 'add':
      return { items: [...state.items, ...action.items.map(({ id, file }) => ({ id, file, status: 'uploading' }))] };
    case 'uploaded':
      return mapItem(state, action.id, (item) => ({
        ...item,
        status: action.attachment.status === 'quarantined' ? 'quarantined' : 'ready',
        attachmentId: action.attachment.attachment_id,
      }));
    case 'failed':
      return mapItem(state, action.id, (item) => ({ ...item, status: 'failed', reason: action.reason }));
    case 'retry':
      return mapItem(state, action.id, (item) => (item.status === 'failed' ? { id: item.id, file: item.file, status: 'uploading' } : item));
    case 'remove':
      return { items: state.items.filter((item) => item.id !== action.id) };
    case 'clear':
      return emptyDraft;
    default:
      return state;
  }
}

function mapItem(state, id, update) {
  if (!state.items.some((item) => item.id === id)) return state;
  return { items: state.items.map((item) => (item.id === id ? update(item) : item)) };
}

/** Whether the send button may be pressed. */
export function canSend({ body, items, sending }) {
  if (sending) return false;
  if (items.some((item) => item.status === 'uploading' || item.status === 'failed')) return false;
  return String(body ?? '').trim().length > 0 || items.length > 0;
}

/** Hint key shown while sending is blocked by an item, or null. */
export function blockedHintKey(items) {
  if (items.some((item) => item.status === 'failed')) return 'attachments.blockedByFailed';
  if (items.some((item) => item.status === 'uploading')) return 'attachments.waitUploading';
  return null;
}

/** ids to send as attachment_ids (ready and quarantined items). */
export function attachmentIdsOf(items) {
  return items.filter((item) => item.attachmentId && (item.status === 'ready' || item.status === 'quarantined')).map((item) => item.attachmentId);
}

/** Only File entries of a drop or paste; text items are ignored. */
export function filesFromTransfer(transfer) {
  if (!transfer) return [];
  if (transfer.items && transfer.items.length > 0) {
    return Array.from(transfer.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }
  return Array.from(transfer.files ?? []);
}

/** True when a drag carries files (not dragged text). */
export function isFileDrag(transfer) {
  return Array.from(transfer?.types ?? []).includes('Files');
}

/** Extension shown inside the file icon, e.g. "PDF". */
export function fileExtension(name) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return match ? match[1].toUpperCase() : 'FILE';
}
