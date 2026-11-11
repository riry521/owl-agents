// @ts-check
// Builds the result card shown under a Web Advisor reply that asked Core to send files.
// Pure: returns i18n keys and params, so tests can check each state and the ja/en key sets.

/** @type {Record<string, string>} */
const PROVIDER_LABELS = { slack: 'Slack', discord: 'Discord' };
const REFUSAL_REASONS = new Set([
  'preferred_provider_unset',
  'default_destination_unset',
  'default_provider_not_configured',
  'default_channel_unavailable',
]);
const FILE_STATUSES = new Set(['pending', 'sent', 'failed', 'unknown', 'rejected']);

export const SETTINGS_SECTION_HREF = '/settings#sec-advisor-send-file-destination';

/** @param {any} metadata */
export function isFileDeliveryMetadata(metadata) {
  return Boolean(metadata) && metadata.kind === 'advisor_file_delivery';
}

/** @param {any} bytes */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// pending wins over failed so the card keeps saying "sending" until every report is in.
// Files Core refused are ignored unless nothing else is left.
/** @param {any[]} files */
function deliveryState(files) {
  const sent = files.filter((file) => file.status !== 'rejected');
  if (sent.length === 0) return 'failed';
  if (sent.some((file) => file.status === 'pending')) return 'pending';
  if (sent.some((file) => file.status === 'failed')) return 'failed';
  if (sent.some((file) => file.status === 'unknown')) return 'unknown';
  return 'sent';
}

/** @param {any} metadata */
export function fileDeliveryView(metadata) {
  /** @type {any[]} */
  const rawFiles = Array.isArray(metadata?.files) ? metadata.files : [];
  const files = rawFiles.map((file) => ({
    name: String(file?.name ?? ''),
    size: formatFileSize(file?.size),
    status: FILE_STATUSES.has(file?.status) ? file.status : 'unknown',
    statusKey: `advisor.fileDelivery.status.${FILE_STATUSES.has(file?.status) ? file.status : 'unknown'}`,
    reason: typeof file?.message === 'string' && file.message ? file.message : null,
  }));
  const notice = typeof metadata?.notice === 'string' && metadata.notice ? metadata.notice : null;
  const destination = metadata?.destination ?? null;

  if (!destination) {
    const reason = REFUSAL_REASONS.has(metadata?.refusal) ? metadata.refusal : 'default_destination_unset';
    return {
      state: 'refused',
      platform: null,
      headingKey: 'advisor.fileDelivery.headingRefused',
      headingParams: { channel: '' },
      sourceKey: null,
      subKey: `advisor.fileDelivery.refusal.${reason}`,
      subParams: { platform: '', channel: '' },
      files,
      notice,
      settingsHref: SETTINGS_SECTION_HREF,
    };
  }

  const provider = Object.hasOwn(PROVIDER_LABELS, destination.provider) ? destination.provider : null;
  const platform = provider ? PROVIDER_LABELS[provider] : String(destination.provider ?? '');
  const channel = String(destination.display_name ?? destination.channel_id ?? '');
  const state = deliveryState(files);
  const sourceKey =
    destination.source === 'default_destination'
      ? 'advisor.fileDelivery.sourceDefault'
      : destination.source === 'window_binding'
        ? 'advisor.fileDelivery.sourceWindow'
        : null;
  return {
    state,
    platform: { provider, label: platform },
    headingKey: state === 'unknown' ? 'advisor.fileDelivery.headingUnknown' : `advisor.fileDelivery.heading.${state}`,
    headingParams: { channel },
    sourceKey: state === 'unknown' ? null : sourceKey,
    subKey: state === 'pending' ? 'advisor.fileDelivery.subPending' : state === 'unknown' ? 'advisor.fileDelivery.subUnknown' : null,
    subParams: { platform, channel },
    files,
    notice,
    settingsHref: null,
  };
}
