'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, createModelPreset, deleteModelPreset, getModelPresets, updateModelPreset, updateModelSettings } from '@/lib/api-client';
import type { ModelPreset, RoleModelSetting } from '@/lib/types';
import { presetMatchesSettings, presetToRoleInputs } from '@/lib/model-presets';
import { roleDisplayName } from '@/lib/format';
import { humanizeError } from '@/lib/settings-errors';
import { useLocale, type Locale, type TFunction } from '@/lib/i18n';

/** How long a two-tap (overwrite/delete) confirm stays armed before reverting. */
const ARM_MS = 3000;

/** True when the preset list changed underneath us, so it has to be reloaded before retrying. */
function isStalePresetError(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.code === 'version_conflict' || error.code === 'model_preset_not_found');
}

/** A rejected role setting, named after the role when the server says which one. */
function humanizeRoleError(error: ApiRequestError, t: TFunction, locale: Locale): string {
  const role = error.details.role;
  return typeof role === 'string'
    ? `${humanizeError(error, t)}${t('settings.presets.errorApplyRoleSuffix', { role: roleDisplayName(role, locale) })}`
    : humanizeError(error, t);
}

/** Errors from the model-preset commands themselves (create/rename/overwrite/delete). */
function humanizePresetError(error: unknown, t: TFunction, locale: Locale): string {
  if (error instanceof ApiRequestError) {
    if (isStalePresetError(error)) return t('settings.presets.errorStale');
    if (error.code === 'validation_error') {
      if (error.details.field === 'presets') return t('settings.presets.errorLimit');
      if (error.details.field === 'roles') return humanizeRoleError(error, t, locale);
      return t('settings.presets.errorValidation');
    }
  }
  return humanizeError(error, t);
}

/** Errors from applying a preset, which is a plain PUT /settings/models under the hood. */
function humanizeApplyError(error: unknown, t: TFunction, locale: Locale): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'version_conflict') return t('settings.presets.errorVersionConflict');
    if (error.code === 'validation_error') return humanizeRoleError(error, t, locale);
  }
  return humanizeError(error, t);
}

export function ModelPresetsBar({
  savedRoles,
  currentVersion,
  formBusy,
  hasUnsavedEdits,
  onApplied,
}: {
  /** The last-persisted model settings (not unsaved form edits); null while settings are loading. */
  savedRoles: RoleModelSetting[] | null;
  /** The model settings row's version, needed to apply a preset via PUT /settings/models. */
  currentVersion: number;
  /** True while the main settings form has its own save in flight. */
  formBusy?: boolean;
  /** True when the role-card form has edits not yet saved; those are never included in a new preset. */
  hasUnsavedEdits?: boolean;
  /** Called with the PUT /settings/models response after a preset is applied. */
  onApplied: (result: { roles: RoleModelSetting[]; version: number }) => void;
}) {
  const { t, locale } = useLocale();
  const [presets, setPresets] = useState<ModelPreset[] | null>(null);
  const [presetsVersion, setPresetsVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [overwritingId, setOverwritingId] = useState<string | null>(null);
  const [overwriteArmedId, setOverwriteArmedId] = useState<string | null>(null);
  const overwriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const aliveRef = useRef(true);
  // Every preset command carries the same list version, so only one may be in flight at a time.
  const anyBusy = applyingId !== null || overwritingId !== null || deletingId !== null || renameSavingId !== null || creating;

  const reloadPresets = useCallback(async () => {
    try {
      const data = await getModelPresets();
      if (!aliveRef.current) return;
      setPresets(data.presets);
      setPresetsVersion(data.version);
      setLoadError(null);
    } catch (err) {
      console.error('[Owl] Model presets load failed', err);
      if (aliveRef.current) setLoadError(humanizePresetError(err, t, locale));
    }
  }, [t, locale]);

  useEffect(() => {
    aliveRef.current = true;
    void reloadPresets();
    return () => {
      aliveRef.current = false;
    };
  }, [reloadPresets]);

  /** Shows a preset command's error; a stale list is reloaded so the next attempt can succeed. */
  function failPresetCommand(err: unknown) {
    setError(humanizePresetError(err, t, locale));
    if (isStalePresetError(err)) void reloadPresets();
  }

  useEffect(() => () => {
    if (overwriteTimerRef.current !== null) clearTimeout(overwriteTimerRef.current);
    if (deleteTimerRef.current !== null) clearTimeout(deleteTimerRef.current);
  }, []);

  async function handleApply(preset: ModelPreset) {
    if (!savedRoles || anyBusy) return;
    setApplyingId(preset.id);
    setNotice(null);
    setError(null);
    try {
      const result = await updateModelSettings(presetToRoleInputs(preset), currentVersion);
      onApplied(result);
      setNotice(t('settings.presets.applySuccess', { name: preset.name }));
    } catch (err) {
      console.error('[Owl] Preset apply failed', err);
      setError(humanizeApplyError(err, t, locale));
    } finally {
      setApplyingId(null);
    }
  }

  function handleOverwriteClick(preset: ModelPreset) {
    if (overwriteArmedId !== preset.id) {
      if (overwriteTimerRef.current !== null) clearTimeout(overwriteTimerRef.current);
      setOverwriteArmedId(preset.id);
      overwriteTimerRef.current = setTimeout(() => setOverwriteArmedId(null), ARM_MS);
      return;
    }
    if (overwriteTimerRef.current !== null) clearTimeout(overwriteTimerRef.current);
    setOverwriteArmedId(null);
    void doOverwrite(preset);
  }

  async function doOverwrite(preset: ModelPreset) {
    if (!savedRoles) return;
    setOverwritingId(preset.id);
    setNotice(null);
    setError(null);
    try {
      const result = await updateModelPreset(preset.id, { roles: presetToRoleInputs({ roles: savedRoles }) }, presetsVersion);
      setPresets(result.presets);
      setPresetsVersion(result.version);
      setNotice(t('settings.presets.overwriteSuccess', { name: result.preset.name }));
    } catch (err) {
      console.error('[Owl] Preset overwrite failed', err);
      failPresetCommand(err);
    } finally {
      setOverwritingId(null);
    }
  }

  function handleDeleteClick(preset: ModelPreset) {
    if (deleteArmedId !== preset.id) {
      if (deleteTimerRef.current !== null) clearTimeout(deleteTimerRef.current);
      setDeleteArmedId(preset.id);
      deleteTimerRef.current = setTimeout(() => setDeleteArmedId(null), ARM_MS);
      return;
    }
    if (deleteTimerRef.current !== null) clearTimeout(deleteTimerRef.current);
    setDeleteArmedId(null);
    void doDelete(preset);
  }

  async function doDelete(preset: ModelPreset) {
    setDeletingId(preset.id);
    setNotice(null);
    setError(null);
    try {
      const result = await deleteModelPreset(preset.id, presetsVersion);
      setPresets(result.presets);
      setPresetsVersion(result.version);
      setNotice(t('settings.presets.deleteSuccess', { name: preset.name }));
    } catch (err) {
      console.error('[Owl] Preset delete failed', err);
      failPresetCommand(err);
    } finally {
      setDeletingId(null);
    }
  }

  function startRename(preset: ModelPreset) {
    setRenamingId(preset.id);
    setRenameDraft(preset.name);
    setNotice(null);
    setError(null);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameDraft('');
  }

  async function saveRename(preset: ModelPreset) {
    const name = renameDraft.trim();
    if (!name || anyBusy) return;
    setRenameSavingId(preset.id);
    setNotice(null);
    setError(null);
    try {
      const result = await updateModelPreset(preset.id, { name }, presetsVersion);
      setPresets(result.presets);
      setPresetsVersion(result.version);
      setRenamingId(null);
      setNotice(t('settings.presets.renameSuccess', { name: result.preset.name }));
    } catch (err) {
      console.error('[Owl] Preset rename failed', err);
      failPresetCommand(err);
    } finally {
      setRenameSavingId(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || !savedRoles || anyBusy) return;
    setCreating(true);
    setNotice(null);
    setError(null);
    try {
      const result = await createModelPreset({ name, roles: presetToRoleInputs({ roles: savedRoles }) }, presetsVersion);
      setPresets(result.presets);
      setPresetsVersion(result.version);
      setNewName('');
      setNotice(t('settings.presets.createSuccess', { name: result.preset.name }));
    } catch (err) {
      console.error('[Owl] Preset create failed', err);
      failPresetCommand(err);
    } finally {
      setCreating(false);
    }
  }

  const inUsePreset = savedRoles ? presets?.find((preset) => presetMatchesSettings(preset, savedRoles)) ?? null : null;

  return (
    <div className="model-presets" aria-labelledby="sec-model-presets">
      <h3 className="model-presets__title" id="sec-model-presets">{t('settings.presets.title')}</h3>

      <div className="model-presets__status">
        {inUsePreset ? (
          <span className="badge badge--accent">{t('settings.presets.inUse', { name: inUsePreset.name })}</span>
        ) : (
          <span className="note">{t('settings.presets.notApplied')}</span>
        )}
      </div>

      {notice && <span className="note note--success model-presets__notice">{notice}</span>}
      {error && <div className="error model-presets__notice">{error}</div>}
      {loadError && <div className="error model-presets__notice">{loadError}</div>}

      {presets === null ? (
        <p className="empty">{t('common.loading')}</p>
      ) : presets.length === 0 ? (
        <p className="empty">{t('settings.presets.empty')}</p>
      ) : (
        <div className="list model-presets__list">
          {presets.map((preset) => {
            const inUse = savedRoles ? presetMatchesSettings(preset, savedRoles) : false;

            if (renamingId === preset.id) {
              return (
                <div className="row model-presets__row" key={preset.id}>
                  <div className="row__main model-presets__rename">
                    <input
                      className="input"
                      value={renameDraft}
                      onChange={(ev) => setRenameDraft(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          void saveRename(preset);
                        } else if (ev.key === 'Escape') {
                          cancelRename();
                        }
                      }}
                      maxLength={60}
                      disabled={renameSavingId === preset.id}
                      autoFocus
                    />
                  </div>
                  <div className="row__end">
                    <button
                      type="button"
                      className="btn btn--small btn--primary"
                      onClick={() => void saveRename(preset)}
                      disabled={anyBusy || !renameDraft.trim()}
                    >
                      {renameSavingId === preset.id ? t('common.saving') : t('settings.presets.renameSave')}
                    </button>
                    <button type="button" className="btn btn--small" onClick={cancelRename} disabled={renameSavingId === preset.id}>
                      {t('settings.presets.renameCancel')}
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div className={`row model-presets__row ${inUse ? 'model-presets__row--active' : ''}`} key={preset.id}>
                <div className="row__main">
                  <div className="row__title">
                    {preset.name}
                    {inUse && <span className="badge badge--accent badge--ml">{t('settings.presets.inUseBadge')}</span>}
                  </div>
                </div>
                <div className="row__end">
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    title={t('settings.presets.applyTitle')}
                    onClick={() => void handleApply(preset)}
                    disabled={formBusy || anyBusy || !savedRoles}
                  >
                    {applyingId === preset.id ? t('common.saving') : t('settings.presets.apply')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => handleOverwriteClick(preset)}
                    disabled={formBusy || anyBusy || !savedRoles}
                  >
                    {overwritingId === preset.id
                      ? t('common.saving')
                      : overwriteArmedId === preset.id
                        ? t('settings.presets.overwriteConfirm')
                        : t('settings.presets.overwrite')}
                  </button>
                  <button type="button" className="btn btn--small" onClick={() => startRename(preset)} disabled={formBusy || anyBusy}>
                    {t('settings.presets.rename')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    onClick={() => handleDeleteClick(preset)}
                    disabled={formBusy || anyBusy}
                  >
                    {deletingId === preset.id
                      ? t('common.saving')
                      : deleteArmedId === preset.id
                        ? t('settings.presets.deleteConfirm')
                        : t('settings.presets.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="model-presets__save">
        <input
          className="input"
          value={newName}
          onChange={(ev) => setNewName(ev.target.value)}
          placeholder={t('settings.presets.namePlaceholder')}
          onKeyDown={(ev) => {
            // The bar sits inside the model settings form; Enter here must not save that form.
            if (ev.key === 'Enter') {
              ev.preventDefault();
              void handleCreate();
            }
          }}
          maxLength={60}
          disabled={creating}
        />
        <button type="button" className="btn btn--small" onClick={() => void handleCreate()} disabled={anyBusy || !newName.trim() || !savedRoles}>
          {creating ? t('common.saving') : t('settings.presets.saveCurrent')}
        </button>
        {hasUnsavedEdits && <span className="note model-presets__unsaved-note">{t('settings.presets.unsavedNote')}</span>}
      </div>
    </div>
  );
}
