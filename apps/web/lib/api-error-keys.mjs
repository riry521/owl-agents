/**
 * API エラーを画面の i18n キーに直す共通処理。
 * network_error・runtime_config_unavailable・invalid_runtime_config・invalid_response・
 * version_conflict・validation_error の対応をここに集め、各画面は自分のキーだけを渡す。
 * keys: { network, invalidResponse, versionConflict, validation, fallback, codes, networkFrom }
 *   codes は画面固有のコード → キー。networkFrom: 'kind' の画面は network を error.kind だけで決め、
 *   code の network_error・runtime_config_unavailable は見ない（HTTP 500 以上は kind が server_error になるため結果が違う）。
 * 渡されなかったキーのコードは fallback になる。
 */

/** @param {unknown} error @param {'code' | 'kind'} key */
export function apiErrorField(error, key) {
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const value = /** @type {Record<string, unknown>} */ (error)[key];
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/**
 * @param {string} code
 * @param {string} kind
 * @param {{ network?: string, invalidResponse?: string, versionConflict?: string, validation?: string, fallback: string, codes?: Record<string, string>, networkFrom?: 'code' | 'kind' }} keys
 * @returns {string}
 */
export function apiErrorKeyForCode(code, kind, keys) {
  if (keys.codes && Object.hasOwn(keys.codes, code)) return keys.codes[code];
  const byKind = keys.networkFrom === 'kind';
  switch (code) {
    case 'validation_error':
      if (keys.validation) return keys.validation;
      break;
    case 'version_conflict':
      if (keys.versionConflict) return keys.versionConflict;
      break;
    case 'network_error':
    case 'runtime_config_unavailable':
      if (keys.network && !byKind) return keys.network;
      break;
    case 'invalid_runtime_config':
    case 'invalid_response':
      if (keys.invalidResponse) return keys.invalidResponse;
      break;
  }
  if (byKind && keys.network && kind === 'network_error') return keys.network;
  return keys.fallback;
}

/**
 * ApiRequestError は Error.message に code を入れるので、Error.message を code として使う。
 * @param {unknown} error @param {(key: string) => string} t @param {Parameters<typeof apiErrorKeyForCode>[2]} keys
 */
export function humanizeApiError(error, t, keys) {
  return t(apiErrorKeyForCode(error instanceof Error ? error.message : '', '', keys));
}

/**
 * code と kind を error のプロパティから読む画面用。Error.message は見ない。
 * @param {unknown} error @param {(key: string) => string} t @param {Parameters<typeof apiErrorKeyForCode>[2]} keys
 */
export function humanizeApiErrorFields(error, t, keys) {
  return t(apiErrorKeyForCode(apiErrorField(error, 'code'), apiErrorField(error, 'kind'), keys));
}

export const SETTINGS_ERROR_KEYS = {
  validation: 'settings.errorValidation',
  versionConflict: 'settings.errorVersionConflict',
  network: 'settings.errorNetwork',
  invalidResponse: 'settings.errorInvalidResponse',
  fallback: 'settings.errorDefault',
};

const BOARD_KEYS = {
  validation: 'board.errorValidation',
  versionConflict: 'board.errorVersionConflict',
  network: 'board.errorNetwork',
  invalidResponse: 'board.errorInvalidResponse',
  fallback: 'board.errorDefault',
  codes: {
    project_not_found: 'board.errorProjectNotFound',
    idempotency_conflict: 'board.errorIdempotencyConflict',
  },
};

/** 設定画面・モデルプリセットなど settings.* の文言を使う画面で共有する。 */
export const humanizeSettingsError = (/** @type {unknown} */ error, /** @type {(key: string) => string} */ t) =>
  humanizeApiError(error, t, SETTINGS_ERROR_KEYS);

/** ボードとアーカイブで共有する。 */
export const humanizeBoardError = (/** @type {unknown} */ error, /** @type {(key: string) => string} */ t) =>
  humanizeApiError(error, t, BOARD_KEYS);
