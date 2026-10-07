import type { ModelPreset, RoleModelSetting, RoleModelSettingInput } from '@/lib/types';

/** The fields that define a role's model configuration; catalog_version and array order don't count. */
type ComparableRole = Pick<RoleModelSetting, 'role' | 'provider' | 'model' | 'effort'>;

function roleFingerprint(role: ComparableRole): string {
  return [role.role, role.provider, role.model, role.effort].join('\u0000');
}

/**
 * True when a preset's roles exactly match a set of role settings: same role, provider, model
 * and effort for every role, regardless of catalog_version or array order. Used to tell whether
 * the currently saved model settings match a saved preset.
 */
export function presetMatchesSettings(preset: Pick<ModelPreset, 'roles'>, roles: readonly ComparableRole[]): boolean {
  if (preset.roles.length !== roles.length) return false;
  const expected = new Set(preset.roles.map(roleFingerprint));
  const actual = new Set(roles.map(roleFingerprint));
  if (expected.size !== actual.size) return false;
  for (const fingerprint of expected) {
    if (!actual.has(fingerprint)) return false;
  }
  return true;
}

/** Maps a preset's roles to the PUT /settings/models payload shape. */
export function presetToRoleInputs(preset: Pick<ModelPreset, 'roles'>): RoleModelSettingInput[] {
  return preset.roles.map(({ role, provider, model, effort }) => ({
    role: role as RoleModelSettingInput['role'],
    provider,
    model,
    effort: effort as RoleModelSettingInput['effort'],
  }));
}
