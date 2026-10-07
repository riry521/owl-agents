import type { TFunction } from '@/lib/i18n';

/**
 * Maps a Settings-screen API error (its `Error.message`, which `ApiRequestError` sets to the
 * machine-readable code) to a human-readable message. Shared by the model settings form and the
 * model presets bar so their network/invalid-response/default wording matches.
 */
export function humanizeError(error: unknown, t: TFunction): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'validation_error':
      return t('settings.errorValidation');
    case 'version_conflict':
      return t('settings.errorVersionConflict');
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('settings.errorNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('settings.errorInvalidResponse');
    default:
      return t('settings.errorDefault');
  }
}
