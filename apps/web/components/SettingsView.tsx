'use client';

import { Fragment, type FormEvent, useEffect, useRef, useState } from 'react';
import { getModelSettings, getSettingsView, updateModelSettings, saveIntegration, testIntegration, deleteIntegration, setHybridMode, setChildRunSettings, createProvider, deleteProvider, testProvider, saveProvider, getProviderModels, setProviderModels as setProviderModelsApi, setTypesafeApiKey, setAdvisorPersona, putAdvisorFolders, putRemakeLimitSettings, getKnowledgeStorage, putKnowledgeStorage, setOwnerLanguage, setKnowledgeAutomationSettings, ApiRequestError } from '@/lib/api-client';
import type { RoleModelSetting, RoleModelSettingInput, IntegrationStatus, ChildRunSettings, ProviderInfo, SaveProviderPayload, AdvisorFolders, RemakeLimitSettings, KnowledgeStorageStatus, KnowledgeAutomationSettingsData, KnowledgeAutomationSettingsInput } from '@/lib/types';
import { roleDisplayName } from '@/lib/format';
import { useLocale, type Locale } from '@/lib/i18n';
import { REMAKE_TASK_TYPES, remakeLimitsToDraft, draftToRemakeLimits } from '@/lib/remake-limits.mjs';
import { humanizeError } from '@/lib/settings-errors';
import { presetMatchesSettings } from '@/lib/model-presets';
import { ModelPresetsBar } from '@/components/ModelPresetsBar';
import { FolderPickerDialog } from '@/components/FolderPickerDialog';
import { useView } from '@/lib/view-loader';

/** Every settings section from GET /settings/view, plus the models version that view leaves out. */
interface SettingsData {
  models: { roles: RoleModelSetting[]; version: number };
  providers: ProviderInfo[];
  hybrid: { hybrid_mode: boolean };
  child_runs: ChildRunSettings;
  language: { language: Locale };
  remake_limits: RemakeLimitSettings;
  knowledge_automation: KnowledgeAutomationSettingsData;
  advisor_persona: { advisor_persona: string };
  advisor_folders: AdvisorFolders;
  integrations: { integrations: IntegrationStatus[] };
  typesafe: { typesafe_api_key: string };
}

async function fetchSettings(): Promise<SettingsData> {
  const [view, models] = await Promise.all([getSettingsView(), getModelSettings()]);
  return { ...(view as unknown as SettingsData), models };
}

/** The shared `settings` view; every section reads its part of it and refreshes it after a change. */
function useSettings() {
  return useView('settings', fetchSettings);
}

/** Fixed role order shown regardless of what the GET response returns them in. */
const ROLE_ORDER: RoleModelSettingInput['role'][] = ['advisor', 'manager', 'designer', 'lead_designer', 'worker', 'reviewer', 'librarian', 'curator'];
const EFFORT_OPTIONS: RoleModelSettingInput['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CHILD_PROVIDER_ORDER: ChildRunSettings['default_provider'][] = ['claude', 'codex'];
const CHILD_PARENT_HARNESSES: ChildRunSettings['default_provider'][] = ['claude', 'codex'];
const CHILD_PROVIDER_MODEL_SOURCE: Record<ChildRunSettings['default_provider'], string> = { claude: 'anthropic', codex: 'openai' };
const DEFAULT_BASE_URL_BY_HARNESS: Record<string, string> = {
  claude: 'https://api.anthropic.com',
  codex: 'https://api.openai.com/v1',
};

const ROLE_META: Record<string, { gradient: string; desc: string; icon: string }> = {
  advisor: {
    gradient: 'role-card__icon--advisor',
    desc: '壁打ち・方針決定',
    icon: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  },
  manager: {
    gradient: 'role-card__icon--manager',
    desc: '計画・タスク分解',
    icon: '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>',
  },
  designer: {
    gradient: 'role-card__icon--designer',
    desc: '設計',
    icon: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  },
  lead_designer: {
    gradient: 'role-card__icon--designer',
    desc: '難しい設計・レビュー後の引き継ぎ',
    icon: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>',
  },
  worker: {
    gradient: 'role-card__icon--worker',
    desc: 'コード・調査',
    icon: '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>',
  },
  reviewer: {
    gradient: 'role-card__icon--reviewer',
    desc: '品質チェック',
    icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  },
  librarian: {
    gradient: 'role-card__icon--librarian',
    desc: 'ナレッジ整理',
    icon: '<path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2z"/><path d="M8 7h6M8 11h6M8 15h4"/>',
  },
  curator: {
    gradient: 'role-card__icon--curator',
    desc: 'スキルの提案を審査',
    icon: '<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>',
  },
};


type RoleRow = RoleModelSettingInput & { catalog_version: string };

const KNOWLEDGE_TARGET_INVALID_REASONS = [
  'not_empty', 'not_writable', 'nested', 'reserved', 'same_as_current', 'parent_missing', 'not_directory', 'relink_requires_unavailable',
];

function toRows(roles: RoleModelSetting[]): RoleRow[] {
  const byRole = new Map(roles.map((r) => [r.role, r]));
  return ROLE_ORDER.map((role) => {
    const current = byRole.get(role);
    return {
      role,
      provider: current?.provider ?? '',
      model: current?.model ?? '',
      effort: (current?.effort as RoleRow['effort'] | undefined) ?? 'medium',
      catalog_version: current?.catalog_version ?? '—',
    };
  });
}


export function SettingsView() {
  const { t } = useLocale();
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [version, setVersion] = useState(0);
  /** The last-persisted role settings (as opposed to `rows`, which tracks unsaved form edits). */
  const [savedRoles, setSavedRoles] = useState<RoleModelSetting[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [availableProviders, setAvailableProviders] = useState<{id: string; displayName: string; available: boolean}[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [hybridMode, setHybridModeState] = useState<boolean | null>(null);
  const [hybridToggling, setHybridToggling] = useState(false);
  const [childSettings, setChildSettings] = useState<ChildRunSettings | null>(null);
  const [childDefaults, setChildDefaults] = useState<ChildRunSettings['defaults_by_parent_harness'] | null>(null);
  const [childAllowedModels, setChildAllowedModels] = useState<ChildRunSettings['allowed_models']>([]);
  const [childTimeoutMinutes, setChildTimeoutMinutes] = useState(60);
  const [childMaxAttempts, setChildMaxAttempts] = useState(2);
  const [childSettingsLoading, setChildSettingsLoading] = useState(true);
  const [childSettingsSaving, setChildSettingsSaving] = useState(false);
  const [childSettingsNotice, setChildSettingsNotice] = useState<string | null>(null);
  const [childSettingsError, setChildSettingsError] = useState<string | null>(null);

  const settingsView = useSettings();
  const modelsView = useView('provider-models', getProviderModels, { staleMs: 6 * 60 * 60 * 1_000 });

  useEffect(() => {
    const data = settingsView.data?.models;
    if (!data) return;
    // Re-applying the version already held would clobber unsaved form edits.
    if (rows !== null && data.version === version) return;
    setRows(toRows(data.roles));
    setVersion(data.version);
    setSavedRoles(data.roles);
    setLoadError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsView.data]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      console.error('[Owl] Settings load failed', settingsView.error);
      setLoadError(humanizeError(settingsView.error, t));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsView.error]);

  useEffect(() => {
    if (modelsView.data) setProviderModels(modelsView.data);
  }, [modelsView.data]);

  const providersKey = JSON.stringify(settingsView.data?.providers);
  const hybridKey = JSON.stringify(settingsView.data?.hybrid);
  const childRunsKey = JSON.stringify(settingsView.data?.child_runs);

  useEffect(() => {
    const data = settingsView.data;
    if (!data) return;
    setAvailableProviders(data.providers.map((p) => ({ id: p.id, displayName: p.displayName, available: p.available })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersKey]);

  useEffect(() => {
    if (settingsView.data) setHybridModeState(settingsView.data.hybrid.hybrid_mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hybridKey]);

  useEffect(() => {
    const data = settingsView.data;
    if (!data) return;
    const settings = data.child_runs;
    setChildSettings(settings);
    setChildDefaults(settings.defaults_by_parent_harness);
    setChildAllowedModels(settings.allowed_models);
    setChildTimeoutMinutes(settings.timeout_minutes);
    setChildMaxAttempts(settings.max_attempts);
    setChildSettingsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childRunsKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      setHybridModeState(false);
      setChildSettingsError(humanizeError(settingsView.error, t));
      setChildSettingsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsView.error]);

  function updateRow(role: RoleRow['role'], patch: Partial<RoleRow>) {
    setRows((current) => (current ? current.map((row) => (row.role === role ? { ...row, ...patch } : row)) : current));
  }

  async function onSave(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!rows) return;
    for (const row of rows) {
      if (!row.provider.trim() || !row.model.trim()) {
        setSaveError(t('settings.allFieldsRequired'));
        return;
      }
    }

    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      const input: RoleModelSettingInput[] = rows.map(({ role, provider, model, effort }) => ({
        role,
        provider: provider.trim(),
        model: model.trim(),
        effort,
      }));
      const result = await updateModelSettings(input, version);
      setRows(toRows(result.roles));
      setVersion(result.version);
      setSavedRoles(result.roles);
      setSaveNotice(t('settings.saveSuccess'));
    } catch (error) {
      console.error('[Owl] Settings save failed', error);
      setSaveError(humanizeError(error, t));
    } finally {
      setSaving(false);
    }
  }

  /** Mirrors onSave's success handling: a preset apply is itself a PUT of /settings/models. */
  function handlePresetApplied(result: { roles: RoleModelSetting[]; version: number }) {
    setRows(toRows(result.roles));
    setVersion(result.version);
    setSavedRoles(result.roles);
    setSaveError(null);
    setSaveNotice(null);
  }

  async function handleHybridToggle() {
    if (hybridMode === null) return;
    setHybridToggling(true);
    try {
      const next = await setHybridMode(!hybridMode);
      setHybridModeState(next);
      void settingsView.refresh();
    } catch (error) {
      console.error('[Owl] Hybrid mode toggle failed', error);
    } finally {
      setHybridToggling(false);
    }
  }

  function updateChildDefault(
    parentHarness: ChildRunSettings['default_provider'],
    patch: Partial<ChildRunSettings['defaults_by_parent_harness'][ChildRunSettings['default_provider']]>,
  ) {
    setChildDefaults((current) => current ? {
      ...current,
      [parentHarness]: { ...current[parentHarness], ...patch },
    } : current);
  }

  async function handleChildSettingsSave() {
    if (!childSettings || !childDefaults) return;
    setChildSettingsSaving(true);
    setChildSettingsNotice(null);
    setChildSettingsError(null);
    try {
      const requiredModels = [
        { provider: childSettings.default_provider, model: childSettings.default_model },
        ...CHILD_PARENT_HARNESSES.map((harness) => ({
          provider: childDefaults[harness].provider,
          model: childDefaults[harness].model.trim(),
        })),
      ];
      if (requiredModels.some((choice) => !choice.model)) {
        setChildSettingsError(t('settings.allFieldsRequired'));
        return;
      }
      const allowedModels = [...childAllowedModels];
      for (const choice of requiredModels) {
        if (!allowedModels.some((item) => item.provider === choice.provider && item.model === choice.model)) {
          allowedModels.push(choice);
        }
      }
      if (allowedModels.length > 20) {
        setChildSettingsError(t('settings.childRunTooManyAllowedModels'));
        return;
      }
      const config: ChildRunSettings = {
        default_provider: childSettings.default_provider,
        default_model: childSettings.default_model,
        default_effort: childSettings.default_effort,
        allowed_efforts: childSettings.allowed_efforts,
        max_timeout_minutes: childSettings.max_timeout_minutes,
        defaults_by_parent_harness: childDefaults,
        allowed_models: allowedModels,
        timeout_minutes: childTimeoutMinutes,
        max_attempts: childMaxAttempts,
      };
      const saved = await setChildRunSettings(config);
      setChildSettings(saved);
      setChildDefaults(saved.defaults_by_parent_harness);
      setChildAllowedModels(saved.allowed_models);
      setChildTimeoutMinutes(saved.timeout_minutes);
      setChildMaxAttempts(saved.max_attempts);
      void settingsView.refresh();
      setChildSettingsNotice(t('settings.childRunSaveSuccess'));
    } catch (error) {
      console.error('[Owl] Child-run settings save failed', error);
      setChildSettingsError(humanizeError(error, t));
    } finally {
      setChildSettingsSaving(false);
    }
  }

  const childModelChoices = CHILD_PROVIDER_ORDER.flatMap((provider) => {
    const source = CHILD_PROVIDER_MODEL_SOURCE[provider];
    const models = [
      ...(providerModels[source] ?? []),
      ...childAllowedModels.filter((choice) => choice.provider === provider).map((choice) => choice.model),
      ...CHILD_PARENT_HARNESSES
        .filter((harness) => childDefaults?.[harness].provider === provider)
        .map((harness) => childDefaults![harness].model),
    ];
    return [...new Set(models.filter((model) => model.trim().length > 0))]
      .map((model) => ({ provider, model }));
  });

  if (!rows) return loadError ? <div className="error">{loadError}</div> : <p className="empty">{t('common.loading')}</p>;

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('settings.title')}</h1>
          <p className="page__sub">{t('settings.subtitle')}</p>
        </div>
      </div>
      {loadError && <div className="error mt-10">{loadError}</div>}

      <form onSubmit={onSave}>
        <section className="panel" aria-labelledby="sec-model-settings">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div>
              <h2 className="panel__title" id="sec-model-settings" style={{ marginBottom: '2px' }}>
                {t('settings.modelSettings')}
              </h2>
            </div>
            <button type="submit" className="btn btn--primary" disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
          {saveNotice && <span className="note note--success" style={{ marginBottom: '12px', display: 'block' }}>{saveNotice}</span>}
          {saveError && <div className="error" style={{ marginBottom: '12px' }}>{saveError}</div>}

          <ModelPresetsBar
            savedRoles={savedRoles}
            currentVersion={version}
            formBusy={saving}
            hasUnsavedEdits={savedRoles !== null && !presetMatchesSettings(
              { roles: savedRoles },
              rows.map(({ role, provider, model, effort }) => ({ role, provider, model, effort })),
            )}
            onApplied={handlePresetApplied}
          />

          {/* Role Cards */}
          <div>
            {rows.map((row) => {
              const meta = ROLE_META[row.role];
              return (
                <div className="role-card" key={row.role}>
                  <div className="role-card__info">
                    <div className={`role-card__icon ${meta?.gradient ?? ''}`}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" dangerouslySetInnerHTML={{ __html: meta?.icon ?? '' }} />
                    </div>
                    <div>
                      <div className="role-card__name">{roleDisplayName(row.role)}</div>
                      <div className="role-card__desc">{meta?.desc ?? ''}</div>
                    </div>
                  </div>
                  <div className="role-card__fields">
                    <div className="role-card__field">
                      <label>Provider</label>
                      <select className="select" value={row.provider} onChange={(ev) => updateRow(row.role, { provider: ev.target.value })} disabled={saving}>
                        {[...new Set([row.provider, ...availableProviders.filter((ap) => ap.available).map((ap) => ap.id)].filter((p) => p.length > 0))].map((pid) => {
                          const info = availableProviders.find((ap) => ap.id === pid);
                          return <option key={pid} value={pid}>{info?.displayName ?? pid}</option>;
                        })}
                      </select>
                    </div>
                    <div className="role-card__field">
                      <label>Model</label>
                      {(() => {
                        const models = providerModels[row.provider] ?? [];
                        return models.length > 0 ? (
                          <select className="select" value={row.model} onChange={(ev) => updateRow(row.role, { model: ev.target.value })} disabled={saving}>
                            {[...new Set([row.model, ...models].filter((m) => m.length > 0))].map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        ) : (
                          <input className="input" value={row.model} onChange={(ev) => updateRow(row.role, { model: ev.target.value })} placeholder="auto (or model ID)" maxLength={200} disabled={saving} />
                        );
                      })()}
                    </div>
                    {!(/router/i.test(row.provider)) && (
                      <div className="role-card__field role-card__field--effort">
                        <label>Effort</label>
                        <select className="select" value={row.effort} onChange={(ev) => updateRow(row.role, { effort: ev.target.value as RoleRow['effort'] })} disabled={saving}>
                          {EFFORT_OPTIONS.map((e) => (
                            <option key={e} value={e}>{e}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Hybrid Mode Card */}
          <div className="hybrid-card">
            <div className="hybrid-card__header">
              <div className="hybrid-card__info">
                <div className="hybrid-card__icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 00-1.172-2.872L3 3"/><path d="M15 9l6-6"/></svg>
                </div>
                <div>
                  <div className="hybrid-card__title">Hybrid Mode</div>
                  <div className="hybrid-card__desc">{t('settings.hybridModeDescription')}</div>
                </div>
              </div>
              <button
                type="button"
                className={`toggle-switch toggle-switch--${hybridMode ? 'on' : 'off'}`}
                onClick={handleHybridToggle}
                disabled={hybridToggling}
                aria-label="Toggle hybrid mode"
              />
            </div>
            {hybridMode && (
              <div className="hybrid-card__executor">
                {childSettingsLoading ? (
                  <p className="empty">{t('common.loading')}</p>
                ) : childSettingsError && !childSettings ? (
                  <div className="error" role="alert">{childSettingsError}</div>
              ) : childSettings && childDefaults && (
                <>
                  <h3 className="role-card__name" style={{ margin: '0 0 12px' }}>{t('settings.childRunSettings')}</h3>
                  <p className="settings-disclosure__hint">{t('settings.childRunSettingsDescription')}</p>
                  {CHILD_PARENT_HARNESSES.map((harness) => {
                    const defaults = childDefaults[harness];
                    const models = [...new Set(childModelChoices.filter((choice) => choice.provider === defaults.provider).map((choice) => choice.model))];
                    const providerId = `child-default-${harness}-provider`;
                    const modelId = `child-default-${harness}-model`;
                    const effortId = `child-default-${harness}-effort`;
                    return (
                      <fieldset key={harness} className="form-field" style={{ border: 0, padding: 0, margin: '16px 0 0' }} disabled={childSettingsSaving}>
                        <legend>{t(`settings.childRunParent${harness === 'claude' ? 'Claude' : 'Codex'}`)}</legend>
                        <div className="role-card__fields">
                          <div className="role-card__field">
                            <label htmlFor={providerId}>{t('settings.childRunDefaultProvider')}</label>
                            <select
                              id={providerId}
                              className="select"
                              value={defaults.provider}
                              onChange={(ev) => {
                                const provider = ev.target.value as ChildRunSettings['default_provider'];
                                const model = defaults.provider === provider
                                  ? defaults.model
                                  : childModelChoices.find((choice) => choice.provider === provider)?.model
                                    ?? providerModels[CHILD_PROVIDER_MODEL_SOURCE[provider]]?.[0]
                                    ?? '';
                                updateChildDefault(harness, { provider, model });
                              }}
                            >
                              <option value="claude">Claude</option>
                              <option value="codex">Codex</option>
                            </select>
                          </div>
                          <div className="role-card__field">
                            <label htmlFor={modelId}>{t('settings.childRunDefaultModel')}</label>
                            {models.length > 0 ? (
                              <select
                                id={modelId}
                                className="select"
                                value={defaults.model}
                                onChange={(ev) => updateChildDefault(harness, { model: ev.target.value })}
                              >
                                {models.map((model) => <option key={model} value={model}>{model}</option>)}
                              </select>
                            ) : (
                              <input
                                id={modelId}
                                className="input"
                                value={defaults.model}
                                onChange={(ev) => updateChildDefault(harness, { model: ev.target.value })}
                                placeholder="model-id"
                                maxLength={200}
                              />
                            )}
                          </div>
                          <div className="role-card__field role-card__field--effort">
                            <label htmlFor={effortId}>{t('settings.childRunDefaultEffort')}</label>
                            <select
                              id={effortId}
                              className="select"
                              value={defaults.effort ?? ''}
                              onChange={(ev) => updateChildDefault(harness, { effort: ev.target.value ? ev.target.value as NonNullable<ChildRunSettings['default_effort']> : null })}
                            >
                              <option value="">{t('common.none')}</option>
                              {childSettings.allowed_efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                            </select>
                          </div>
                        </div>
                      </fieldset>
                    );
                  })}

                    <fieldset className="form-field" style={{ border: 0, padding: 0, margin: '16px 0 0' }} disabled={childSettingsSaving}>
                      <legend>{t('settings.childRunAllowedModels')}</legend>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '6px 16px', marginTop: '8px' }}>
                        {childModelChoices.map((choice) => {
                          const selected = childAllowedModels.some((model) => model.provider === choice.provider && model.model === choice.model);
                          const isDefault = (choice.provider === childSettings.default_provider && choice.model === childSettings.default_model)
                            || CHILD_PARENT_HARNESSES.some((harness) => childDefaults[harness].provider === choice.provider && childDefaults[harness].model === choice.model);
                          return (
                          <label key={`${choice.provider}/${choice.model}`} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <input
                                type="checkbox"
                                checked={selected || isDefault}
                                disabled={isDefault || (!selected && childAllowedModels.length >= 20)}
                                onChange={() => setChildAllowedModels((current) => selected
                                  ? current.filter((model) => model.provider !== choice.provider || model.model !== choice.model)
                                  : [...current, choice])}
                              />
                              <span><code>{choice.provider}</code> / {choice.model}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <div className="role-card__fields" style={{ marginTop: '16px' }}>
                      <label className="role-card__field">
                        <span>{t('settings.childRunTimeoutMinutes')}</span>
                        <input className="input" type="number" min={5} max={childSettings.max_timeout_minutes} step={1} value={childTimeoutMinutes} disabled={childSettingsSaving}
                          onChange={(ev) => setChildTimeoutMinutes(Math.trunc(Math.max(5, Math.min(childSettings.max_timeout_minutes, Number(ev.target.value) || 5))))} />
                      </label>
                      <label className="role-card__field">
                        <span>{t('settings.childRunMaxAttempts')}</span>
                        <input className="input" type="number" min={1} max={3} step={1} value={childMaxAttempts} disabled={childSettingsSaving}
                          onChange={(ev) => setChildMaxAttempts(Math.trunc(Math.max(1, Math.min(3, Number(ev.target.value) || 1))))} />
                      </label>
                    </div>
                    <div className="btn-row mt-14">
                      <button type="button" className="btn btn--small" onClick={handleChildSettingsSave} disabled={childSettingsSaving}>
                        {childSettingsSaving ? t('common.saving') : t('settings.childRunSave')}
                      </button>
                      {childSettingsNotice && <span className="note note--success">{childSettingsNotice}</span>}
                      {childSettingsError && <span className="error" role="alert">{childSettingsError}</span>}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Info Note */}
          <div className="settings-info-note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" style={{ flexShrink: 0, marginTop: '1px' }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <div className="settings-info-note__text">
              {t('settings.infoNote')}
            </div>
          </div>
        </section>
      </form>
      <OwnerLanguageSection />
      <AdvisorPersonaSection />
      <AdvisorFoldersSection />
      <RemakeLimitsSection />
      <KnowledgeStorageSection />
      <KnowledgeAutomationSection />
      <ProviderManagementSection providerModels={providerModels} onModelsUpdate={(id, models) => setProviderModels(prev => ({ ...prev, [id]: models }))} />
      <IntegrationsSection />
      <TypesafeSection />
    </>
  );
}

/** The one Owl-wide language setting: agent output, Owl's own text and notifications. */
function OwnerLanguageSection() {
  const { t } = useLocale();
  const [language, setLanguage] = useState<Locale | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.language);
  useEffect(() => {
    if (settingsView.data) setLanguage(settingsView.data.language.language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) setError(t('settings.ownerLanguageError'));
  }, [settingsView.error, settingsView.data, t]);

  async function handleChange(next: Locale) {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      setLanguage(await setOwnerLanguage(next));
      setNotice(t('settings.ownerLanguageSaved'));
    } catch (error) {
      console.error("Settings request failed", error);
      setError(t('settings.ownerLanguageError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="sec-owner-language" style={{ marginTop: '24px' }}>
      <h2 className="panel__title" id="sec-owner-language">{t('settings.ownerLanguage')}</h2>
      <p className="note">{t('settings.ownerLanguageDescription')}</p>
      <div className="btn-row mt-10">
        <select
          className="select"
          aria-labelledby="sec-owner-language"
          value={language ?? ''}
          disabled={language === null || saving}
          onChange={(ev) => void handleChange(ev.target.value as Locale)}
        >
          {language === null && <option value="">{t('common.loading')}</option>}
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
      </div>
      {notice && <p className="note mt-10">{notice}</p>}
      {error && <div className="error mt-10">{error}</div>}
    </section>
  );
}

function AdvisorPersonaSection() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [persona, setPersona] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsView = useSettings();

  const savedValue = settingsView.data?.advisor_persona.advisor_persona;
  useEffect(() => {
    if (savedValue === undefined) return;
    setPersona(savedValue);
    setDraft(savedValue);
    setLoading(false);
  }, [savedValue]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      setError(t('settings.advisorPersonaError'));
      setLoading(false);
    }
  }, [settingsView.error, settingsView.data, t]);

  async function handleSave() {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await setAdvisorPersona(draft.trim());
      setPersona(saved);
      setDraft(saved);
      setNotice(t('settings.advisorPersonaSaved'));
    } catch (error) {
      console.error("Settings request failed", error);
      setError(t('settings.advisorPersonaError'));
    } finally {
      setSaving(false);
    }
  }

  const configured = persona.trim().length > 0;

  return (
    <section className="panel advisor-persona-panel" aria-labelledby="sec-advisor-persona">
      <button
        type="button"
        className="settings-disclosure"
        aria-expanded={open}
        aria-controls="advisor-persona-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="settings-disclosure__info">
          <span className="settings-disclosure__icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3a6 6 0 016 6c0 3.5-2 5-3.5 6.5-.7.7-1 1.5-1 2.5h-3c0-1-.3-1.8-1-2.5C8 14 6 12.5 6 9a6 6 0 016-6z" />
              <path d="M9 21h6M9.5 18h5" />
            </svg>
          </span>
          <span className="settings-disclosure__copy">
            <strong id="sec-advisor-persona">{t('settings.advisorPersona')}</strong>
            <small>{t('settings.advisorPersonaDescription')}</small>
          </span>
        </span>
        <span className="settings-disclosure__right">
          <span className={`settings-disclosure__status ${configured ? 'settings-disclosure__status--configured' : ''}`}>
            {configured ? t('settings.advisorPersonaConfigured') : t('settings.advisorPersonaNotConfigured')}
          </span>
          <svg
            className={`settings-disclosure__chevron ${open ? 'settings-disclosure__chevron--open' : ''}`}
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-label={open ? t('settings.advisorPersonaClose') : t('settings.advisorPersonaOpen')}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div id="advisor-persona-panel" className="settings-disclosure__body" aria-busy={loading || saving}>
          {loading ? (
            <p className="empty">{t('common.loading')}</p>
          ) : (
            <>
              <label className="form-field">
                <span>{t('settings.advisorPersonaLabel')}</span>
                <textarea
                  className="textarea advisor-persona__textarea"
                  value={draft}
                  onChange={(ev) => setDraft(ev.target.value)}
                  placeholder={t('settings.advisorPersonaPlaceholder')}
                  maxLength={8000}
                  rows={7}
                  disabled={saving}
                />
              </label>
              <p className="settings-disclosure__hint">{t('settings.advisorPersonaHint')}</p>
              <div className="btn-row">
                <button type="button" className="btn btn--primary btn--small" onClick={handleSave} disabled={saving}>
                  {saving ? t('common.saving') : t('settings.advisorPersonaSave')}
                </button>
                {notice && <span className="note note--success">{notice}</span>}
              </div>
            </>
          )}
          {error && <div className="error" style={{ marginTop: '12px' }}>{error}</div>}
        </div>
      )}
    </section>
  );
}

// Exported (unlike the other Section helpers in this file) so tests can render it in isolation.
export function AdvisorFoldersSection() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<AdvisorFolders | null>(null);
  const [sharedDir, setSharedDir] = useState('');
  const [screenshotDir, setScreenshotDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ field: 'shared' | 'screenshot'; initialPath: string } | null>(null);

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.advisor_folders);
  useEffect(() => {
    const value = settingsView.data?.advisor_folders;
    if (!value) return;
    setFolders(value);
    setSharedDir(value.shared_dir);
    setScreenshotDir(value.screenshot_dir);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      setError(t('settings.advisorFoldersError'));
      setLoading(false);
    }
  }, [settingsView.error, settingsView.data, t]);

  async function handleSave() {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await putAdvisorFolders({ shared_dir: sharedDir.trim(), screenshot_dir: screenshotDir.trim() });
      setFolders(saved);
      setSharedDir(saved.shared_dir);
      setScreenshotDir(saved.screenshot_dir);
      setNotice(t('settings.advisorFoldersSaved'));
    } catch (err) {
      // The server already localizes validation messages (422); surface those verbatim.
      setError(err instanceof ApiRequestError && err.code === 'validation_error' ? err.rawMessage : humanizeError(err, t));
    } finally {
      setSaving(false);
    }
  }

  const changed = folders !== null && (sharedDir.trim() !== folders.shared_dir || screenshotDir.trim() !== folders.screenshot_dir);

  function openPicker(field: 'shared' | 'screenshot') {
    const draft = field === 'shared' ? sharedDir : screenshotDir;
    const fallback = field === 'shared' ? folders?.defaults.shared_dir : folders?.defaults.screenshot_dir;
    setPicker({ field, initialPath: draft.trim() || fallback || '' });
  }

  return (
    <section className="panel advisor-persona-panel" aria-labelledby="sec-advisor-folders">
      <button
        type="button"
        className="settings-disclosure"
        aria-expanded={open}
        aria-controls="advisor-folders-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="settings-disclosure__info">
          <span className="settings-disclosure__icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
          </span>
          <span className="settings-disclosure__copy">
            <strong id="sec-advisor-folders">{t('settings.advisorFolders')}</strong>
            <small>{t('settings.advisorFoldersDescription')}</small>
          </span>
        </span>
        <span className="settings-disclosure__right">
          <svg
            className={`settings-disclosure__chevron ${open ? 'settings-disclosure__chevron--open' : ''}`}
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-label={open ? t('settings.advisorFoldersClose') : t('settings.advisorFoldersOpen')}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div id="advisor-folders-panel" className="settings-disclosure__body" aria-busy={loading || saving}>
          {loading ? (
            <p className="empty">{t('common.loading')}</p>
          ) : (
            <>
              <label className="form-field">
                <span>{t('settings.advisorFoldersSharedLabel')}</span>
                <div className="project-path-input">
                  <input
                    className="input"
                    style={{ fontFamily: 'monospace' }}
                    value={sharedDir}
                    onChange={(ev) => setSharedDir(ev.target.value)}
                    placeholder={folders?.defaults.shared_dir ?? ''}
                    maxLength={4096}
                    disabled={saving}
                  />
                  <button type="button" className="btn" onClick={() => openPicker('shared')} disabled={saving}>
                    {t('settings.advisorFoldersChoose')}
                  </button>
                </div>
              </label>
              <p className="settings-disclosure__hint">{t('settings.advisorFoldersSharedHint')}</p>
              <div className="btn-row">
                {folders?.custom.shared_dir ? (
                  <button type="button" className="btn btn--small" onClick={() => setSharedDir('')} disabled={saving}>
                    {t('settings.advisorFoldersReset')}
                  </button>
                ) : (
                  <span className="badge badge--gray">{t('settings.advisorFoldersDefaultBadge')}</span>
                )}
              </div>

              <label className="form-field" style={{ marginTop: '16px' }}>
                <span>{t('settings.advisorFoldersScreenshotLabel')}</span>
                <div className="project-path-input">
                  <input
                    className="input"
                    style={{ fontFamily: 'monospace' }}
                    value={screenshotDir}
                    onChange={(ev) => setScreenshotDir(ev.target.value)}
                    placeholder={folders?.defaults.screenshot_dir ?? ''}
                    maxLength={4096}
                    disabled={saving}
                  />
                  <button type="button" className="btn" onClick={() => openPicker('screenshot')} disabled={saving}>
                    {t('settings.advisorFoldersChoose')}
                  </button>
                </div>
              </label>
              <p className="settings-disclosure__hint">{t('settings.advisorFoldersScreenshotHint')}</p>
              <div className="btn-row">
                {folders?.custom.screenshot_dir ? (
                  <button type="button" className="btn btn--small" onClick={() => setScreenshotDir('')} disabled={saving}>
                    {t('settings.advisorFoldersReset')}
                  </button>
                ) : (
                  <span className="badge badge--gray">{t('settings.advisorFoldersDefaultBadge')}</span>
                )}
              </div>

              <div className="btn-row" style={{ marginTop: '16px' }}>
                <button type="button" className="btn btn--primary btn--small" onClick={handleSave} disabled={saving || !changed}>
                  {saving ? t('common.saving') : t('settings.advisorFoldersSave')}
                </button>
                {notice && <span className="note note--success">{notice}</span>}
              </div>
            </>
          )}
          {error && <div className="error" style={{ marginTop: '12px' }}>{error}</div>}
        </div>
      )}

      <FolderPickerDialog
        open={picker !== null}
        initialPath={picker?.initialPath ?? ''}
        onSelect={(path) => {
          if (picker?.field === 'shared') setSharedDir(path);
          else if (picker?.field === 'screenshot') setScreenshotDir(path);
        }}
        onClose={() => setPicker(null)}
      />
    </section>
  );
}

const REMAKE_NUMBER_FIELDS = ['lineage_review_attempts', 'lineage_worker_runs', 'non_functional_remakes', 'base_sync_lineage_review_attempts', 'base_sync_lineage_worker_runs', 'lead_review_rejections'] as const;

export function RemakeLimitsSection() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<RemakeLimitSettings | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof remakeLimitsToDraft> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.remake_limits);
  useEffect(() => {
    const value = settingsView.data?.remake_limits;
    if (!value) return;
    setLoaded(value);
    setDraft(remakeLimitsToDraft(value));
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      setError(t('settings.remakeLimitsError'));
      setLoading(false);
    }
  }, [settingsView.error, settingsView.data, t]);

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await putRemakeLimitSettings(draftToRemakeLimits(draft));
      setLoaded(saved);
      setDraft(remakeLimitsToDraft(saved));
      setNotice(t('settings.remakeLimitsSaved'));
    } catch (err) {
      // Validation messages come from the API; surface them verbatim.
      setError(err instanceof ApiRequestError && err.code === 'validation_error' ? err.rawMessage : humanizeError(err, t));
    } finally {
      setSaving(false);
    }
  }

  const changed = loaded !== null && draft !== null && JSON.stringify(draftToRemakeLimits(draft)) !== JSON.stringify(loaded);

  return (
    <section className="panel advisor-persona-panel" aria-labelledby="sec-remake-limits">
      <button
        type="button"
        className="settings-disclosure"
        aria-expanded={open}
        aria-controls="remake-limits-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="settings-disclosure__info">
          <span className="settings-disclosure__copy">
            <strong id="sec-remake-limits">{t('settings.remakeLimits')}</strong>
            <small>{t('settings.remakeLimitsDescription')}</small>
          </span>
        </span>
        <span className="settings-disclosure__right">
          <svg
            className={`settings-disclosure__chevron ${open ? 'settings-disclosure__chevron--open' : ''}`}
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div id="remake-limits-panel" className="settings-disclosure__body" aria-busy={loading || saving}>
          {loading ? (
            <p className="empty">{t('common.loading')}</p>
          ) : draft && (
            <>
              {REMAKE_NUMBER_FIELDS.map((field) => (
                <label key={field} className="form-field">
                  <span>{t(`settings.remakeLimits_${field}`)}</span>
                  <input
                    className="input"
                    type="number"
                    name={field}
                    value={draft[field]}
                    onChange={(ev) => setDraft({ ...draft, [field]: ev.target.value })}
                    disabled={saving}
                  />
                </label>
              ))}
              <label className="form-field">
                <span>{t('settings.remakeLimits_verification_paths')}</span>
                <textarea
                  className="input"
                  style={{ fontFamily: 'monospace' }}
                  name="verification_paths"
                  rows={6}
                  value={draft.verification_paths}
                  onChange={(ev) => setDraft({ ...draft, verification_paths: ev.target.value })}
                  disabled={saving}
                />
              </label>
              <p className="settings-disclosure__hint">{t('settings.remakeLimitsPathsHint')}</p>
              <fieldset className="form-field" disabled={saving}>
                <legend>{t('settings.remakeLimits_checked_task_types')}</legend>
                {REMAKE_TASK_TYPES.map((type) => (
                  <label key={type} style={{ marginRight: '12px' }}>
                    <input
                      type="checkbox"
                      name={`checked_task_type_${type}`}
                      checked={draft.checked_task_types.includes(type)}
                      onChange={(ev) => setDraft({
                        ...draft,
                        checked_task_types: ev.target.checked
                          ? [...draft.checked_task_types, type]
                          : draft.checked_task_types.filter((item) => item !== type),
                      })}
                    />{' '}
                    {type}
                  </label>
                ))}
              </fieldset>
              <div className="btn-row" style={{ marginTop: '16px' }}>
                <button type="button" className="btn btn--primary btn--small" onClick={handleSave} disabled={saving || !changed}>
                  {saving ? t('common.saving') : t('settings.remakeLimitsSave')}
                </button>
                {notice && <span className="note note--success">{notice}</span>}
              </div>
            </>
          )}
          {error && <div className="error" style={{ marginTop: '12px' }}>{error}</div>}
        </div>
      )}
    </section>
  );
}

const KNOWLEDGE_STORAGE_POLL_MS = 5000;

export function KnowledgeStorageSection() {
  const { t } = useLocale();
  const [status, setStatus] = useState<KnowledgeStorageStatus | null>(null);
  const [path, setPath] = useState('');
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const storageView = useView('knowledge-storage', () => getKnowledgeStorage(), { refreshMs: KNOWLEDGE_STORAGE_POLL_MS });
  const firstStorageRef = useRef(true);

  useEffect(() => {
    const value = storageView.data;
    if (!value) return;
    setStatus(value);
    if (firstStorageRef.current) setPath(value.custom ? value.path : '');
    firstStorageRef.current = false;
  }, [storageView.data]);

  async function handleSave() {
    setMoving(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await putKnowledgeStorage(path.trim());
      setStatus(saved);
      setPath(saved.custom ? saved.path : '');
      setNotice(t('settings.knowledgeStorageSaved', { path: saved.path }));
    } catch (err) {
      const reason = err instanceof ApiRequestError && err.code === 'knowledge_target_invalid' ? err.details.reason : undefined;
      const reasonKey = typeof reason === 'string' ? `settings.knowledgeStorageTargetInvalid_${reason}` : null;
      const localized = reasonKey !== null && KNOWLEDGE_TARGET_INVALID_REASONS.includes(reason as string) ? t(reasonKey) : null;
      // Other 4xx messages come from server-side validation; show them verbatim.
      setError(localized ?? (err instanceof ApiRequestError && err.status !== null && err.status < 500 ? err.rawMessage : humanizeError(err, t)));
    } finally {
      setMoving(false);
    }
  }

  const busy = moving || status?.state === 'moving';
  const progress = status?.move && status.move.files_total !== null ? ` (${status.move.files_done}/${status.move.files_total})` : '';

  return (
    <section className="panel" aria-labelledby="sec-knowledge-storage">
      <h2 id="sec-knowledge-storage" className="panel__title">{t('settings.knowledgeStorage')}</h2>
      <p className="settings-disclosure__hint">{t('settings.knowledgeStorageDescription')}</p>
      {status && (
        <p>
          <span>{t('settings.knowledgeStorageCurrent')}: </span>
          <code>{status.path}</code>{' '}
          {!status.custom && <span className="badge badge--gray">{t('settings.knowledgeStorageDefaultBadge')}</span>}
        </p>
      )}
      {status?.state === 'unavailable' && (
        <div className="error" role="alert">
          {t('settings.knowledgeStorageUnavailable')}{status.reason ? ` (${status.reason})` : ''}
          <button type="button" className="btn btn--small" style={{ marginLeft: '8px' }} onClick={() => void getKnowledgeStorage(true).then(setStatus).catch((error) => console.error('Failed to re-check knowledge storage', error))}>
            {t('settings.knowledgeStorageRecheck')}
          </button>
        </div>
      )}
      <label className="form-field">
        <span>{t('settings.knowledgeStorageLabel')}</span>
        <div className="project-path-input">
          <input
            className="input"
            style={{ fontFamily: 'monospace' }}
            value={path}
            onChange={(ev) => setPath(ev.target.value)}
            placeholder={status?.default_path ?? ''}
            maxLength={4096}
            disabled={busy}
          />
          <button type="button" className="btn" onClick={() => setPickerOpen(true)} disabled={busy}>
            {t('settings.advisorFoldersChoose')}
          </button>
        </div>
      </label>
      <p className="settings-disclosure__hint">{t('settings.knowledgeStorageHint')}</p>
      <div className="btn-row">
        <button type="button" className="btn btn--primary btn--small" onClick={handleSave} disabled={busy || !status}>
          {t('settings.knowledgeStorageSave')}
        </button>
        {busy && <span className="note" role="status">{t('settings.knowledgeStorageMoving')}{progress}</span>}
        {notice && <span className="note note--success">{notice}</span>}
      </div>
      {error && (
        <div className="error" role="alert" style={{ marginTop: '12px' }}>
          {error}
          <div>{t('settings.knowledgeStorageUnchanged', { path: status?.path ?? '' })}</div>
        </div>
      )}
      <FolderPickerDialog
        open={pickerOpen}
        initialPath={path.trim() || status?.path || ''}
        onSelect={setPath}
        onClose={() => setPickerOpen(false)}
      />
    </section>
  );
}

export function KnowledgeAutomationSection() {
  const { t } = useLocale();
  const [settings, setSettings] = useState<KnowledgeAutomationSettingsData | null>(null);
  const [librarianTimes, setLibrarianTimes] = useState<string[]>([]);
  const [researchAutosave, setResearchAutosave] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.knowledge_automation);
  useEffect(() => {
    const value = settingsView.data?.knowledge_automation;
    if (!value) return;
    setSettings(value);
    setLibrarianTimes(value.librarian_times);
    setResearchAutosave(value.research_autosave);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      console.error('[Owl] Knowledge automation settings load failed', settingsView.error);
      setError(humanizeError(settingsView.error, t));
      setLoading(false);
    }
  }, [settingsView.error, settingsView.data, t]);

  const timesInvalid = librarianTimes.length > 24 || librarianTimes.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time));

  function addTime() {
    setLibrarianTimes((current) => {
      if (current.length >= 24) return current;
      const used = new Set(current);
      for (let offset = 0; offset < 24; offset += 1) {
        const hour = (12 + offset) % 24;
        const time = `${String(hour).padStart(2, '0')}:00`;
        if (!used.has(time)) return [...current, time];
      }
      return current;
    });
    setNotice(null);
  }

  async function handleSave() {
    if (!settings || timesInvalid) return;
    const input: KnowledgeAutomationSettingsInput = { librarian_times: librarianTimes, research_autosave: researchAutosave };
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await setKnowledgeAutomationSettings(input);
      setSettings(saved);
      setLibrarianTimes(saved.librarian_times);
      setResearchAutosave(saved.research_autosave);
      setNotice(t('settings.knowledgeAutomationSaved'));
    } catch (err) {
      console.error('[Owl] Knowledge automation settings save failed', err);
      setError(humanizeError(err, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="sec-knowledge-automation" style={{ marginTop: '24px' }}>
      <h2 className="panel__title" id="sec-knowledge-automation">{t('settings.knowledgeAutomationTitle')}</h2>
      {loading ? (
        <p className="empty">{t('common.loading')}</p>
      ) : settings && (
        <>
          <div className="form-field" style={{ marginTop: '16px' }}>
            <span>{t('settings.librarianTimesLabel')}</span>
            {librarianTimes.map((time, index) => (
              <div className="btn-row" key={index}>
                <input
                  className="input"
                  type="time"
                  step={60}
                  value={time}
                  aria-label={`${t('settings.librarianTimesLabel')} ${index + 1}`}
                  disabled={saving}
                  onChange={(ev) => setLibrarianTimes((current) => current.map((value, row) => row === index ? ev.target.value : value))}
                  style={{ maxWidth: '180px' }}
                />
                <button
                  type="button"
                  className="btn btn--small"
                  aria-label={t('settings.librarianTimeRemove')}
                  disabled={saving}
                  onClick={() => setLibrarianTimes((current) => current.filter((_, row) => row !== index))}
                >
                  {t('settings.librarianTimeRemove')}
                </button>
              </div>
            ))}
            <p className="settings-disclosure__hint">{t('settings.librarianTimesHint', { timeZone: settings.time_zone })}</p>
            <div className="btn-row">
              <button type="button" className="btn btn--small" onClick={addTime} disabled={saving || librarianTimes.length >= 24}>
                {t('settings.librarianTimeAdd')}
              </button>
            </div>
          </div>
          {timesInvalid && <p className="error" style={{ marginTop: '8px' }}>{t('settings.librarianTimesInvalid')}</p>}
          <p className="page__sub" style={{ margin: '12px 0' }}>
            {settings.next_librarian_run_at
              ? t('settings.librarianNextRun', { time: new Date(settings.next_librarian_run_at).toLocaleString() })
              : t('settings.librarianNextRunNone')}
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '16px' }}>
            <input
              type="checkbox"
              checked={researchAutosave}
              disabled={saving}
              onChange={(ev) => setResearchAutosave(ev.target.checked)}
            />
            <span>{t('settings.researchAutosaveLabel')}</span>
          </label>
          <p className="settings-disclosure__hint">{t('settings.researchAutosaveHint')}</p>
          <div className="btn-row">
            <button type="button" className="btn btn--primary btn--small" onClick={handleSave} disabled={saving || timesInvalid}>
              {saving ? t('common.saving') : t('common.save')}
            </button>
            {notice && <span className="note note--success">{notice}</span>}
          </div>
        </>
      )}
      {error && <div className="error" style={{ marginTop: '12px' }}>{error}</div>}
    </section>
  );
}

const PROVIDER_HARNESS_OPTIONS = ['claude', 'codex'];

function ProviderManagementSection({ providerModels, onModelsUpdate }: { providerModels: Record<string, string[]>; onModelsUpdate: (providerId: string, models: string[]) => void }) {
  const { t } = useLocale();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newHarness, setNewHarness] = useState('claude');
  const [newBaseUrl, setNewBaseUrl] = useState('');
  const [newApiKeySource, setNewApiKeySource] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editHarness, setEditHarness] = useState('claude');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiKeySource, setEditApiKeySource] = useState('');
  const [modelsExpandedId, setModelsExpandedId] = useState<string | null>(null);
  const [modelEditValues, setModelEditValues] = useState<Record<string, string>>({});
  const [modelSaving, setModelSaving] = useState<string | null>(null);

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.providers);
  useEffect(() => {
    if (!settingsView.data) return;
    setProviders(settingsView.data.providers);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) {
      setNotice(t('settings.providerError'));
      setLoading(false);
    }
  }, [settingsView.error, settingsView.data, t]);

  async function handleTest(id: string) {
    setTesting(id);
    setNotice('');
    try {
      const result = await testProvider(id);
      setNotice(result.ok ? t('settings.testProviderSuccess') : t('settings.testProviderFailed') + ': ' + result.detail);
    } catch (error) {
      console.error('[Owl] Provider test failed', error);
      setNotice(t('settings.testProviderFailed'));
    } finally {
      setTesting(null);
    }
  }

  async function handleRemove(id: string) {
    if (!confirm(t('settings.removeProviderConfirm'))) return;
    try {
      await deleteProvider(id);
      setProviders((prev) => prev.filter((p) => p.id !== id));
      setNotice(t('settings.providerDeleted'));
    } catch (error) {
      console.error('[Owl] Provider remove failed', error);
      setNotice(t('settings.providerError'));
    }
  }

  async function handleAdd() {
    if (!newId.trim() || !newName.trim() || !newBaseUrl.trim()) {
      setNotice(t('settings.providerFieldsRequired'));
      return;
    }
    setSaving(true);
    setNotice('');
    try {
      const payload: SaveProviderPayload & { id: string } = {
        id: newId.trim(),
        displayName: newName.trim(),
        harnessId: newHarness,
      };
      payload.backendUrl = newBaseUrl.trim();
      if (newApiKeySource.trim()) payload.apiKeySource = newApiKeySource.trim();
      const created = await createProvider(payload);
      setProviders((prev) => [...prev, created]);
      void settingsView.refresh();
      setShowAddForm(false);
      setNewId('');
      setNewName('');
      setNewHarness('claude');
      setNewBaseUrl('');
      setNewApiKeySource('');
      setNotice(t('settings.providerSaved'));
    } catch (error) {
      console.error('[Owl] Provider add failed', error);
      setNotice(t('settings.providerError'));
    } finally {
      setSaving(false);
    }
  }

  function openEdit(p: ProviderInfo) {
    setEditingId(p.id);
    setEditName(p.displayName);
    setEditHarness(p.harnessId);
    setEditBaseUrl(p.backendUrl ?? '');
    setEditApiKeySource(p.apiKeySource ?? '');
    setShowAddForm(false);
  }

  async function handleEditSave() {
    if (!editingId || !editName.trim()) return;
    if (!editBaseUrl.trim()) {
      setNotice(t('settings.providerFieldsRequired'));
      return;
    }
    setSaving(true);
    setNotice('');
    try {
      const payload: SaveProviderPayload = {
        displayName: editName.trim(),
        harnessId: editHarness,
      };
      payload.backendUrl = editBaseUrl.trim();
      if (editApiKeySource.trim()) payload.apiKeySource = editApiKeySource.trim();
      const updated = await saveProvider(editingId, payload);
      setProviders((prev) => prev.map((p) => (p.id === editingId ? updated : p)));
      void settingsView.refresh();
      setEditingId(null);
      setNotice(t('settings.providerSaved'));
    } catch (error) {
      console.error('[Owl] Provider edit failed', error);
      setNotice(t('settings.providerError'));
    } finally {
      setSaving(false);
    }
  }

  function getModelEditValue(id: string): string {
    if (id in modelEditValues) return modelEditValues[id];
    return (providerModels[id] ?? []).join('\n');
  }

  async function handleModelSave(id: string) {
    setModelSaving(id);
    try {
      const text = getModelEditValue(id);
      const models = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const saved = await setProviderModelsApi(id, models);
      onModelsUpdate(id, saved);
      setModelEditValues((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setNotice(t('settings.modelListSaved'));
    } catch (error) {
      console.error('[Owl] Model list save failed', error);
      setNotice(t('settings.providerError'));
    } finally {
      setModelSaving(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="sec-providers" style={{ marginTop: '24px' }}>
      <h2 className="panel__title" id="sec-providers">
        {t('settings.providers')}
      </h2>
      <p className="page__sub" style={{ marginBottom: '16px' }}>
        {t('settings.providersSubtitle')}
      </p>
      <p className="page__sub" style={{ marginBottom: '16px' }}>
        {t('settings.modelListsDescription')}
      </p>

      {loading ? <p className="empty">{t('common.loading')}</p> : (
        <div className="list">
          {providers.map((p) => (
            <Fragment key={p.id}>
            <div className="list__row" style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0' }}>
              <span style={{ flex: 1, fontWeight: 500 }}>{p.displayName}</span>
              <span style={{ fontSize: '0.85em', opacity: 0.7 }}>
                {p.harnessId}
              </span>
              <span style={{
                fontSize: '0.8em',
                padding: '2px 8px',
                borderRadius: '4px',
                background: p.available ? 'var(--color-success-bg, #e6f4ea)' : 'var(--color-error-bg, #fce8e6)',
                color: p.available ? 'var(--color-success, #137333)' : 'var(--color-error, #c5221f)',
              }}>
                {p.available ? t('settings.providerAvailable') : t('settings.providerUnavailable')}
              </span>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setModelsExpandedId(modelsExpandedId === p.id ? null : p.id)}
                style={{ fontSize: '0.85em' }}
              >
                {t('settings.modelLists')}
              </button>
              <button
                type="button"
                className="btn btn--small"
                disabled={testing === p.id}
                onClick={() => handleTest(p.id)}
              >
                {testing === p.id ? t('settings.testingProvider') : t('settings.testProvider')}
              </button>
              {!p.isBuiltin && (
                <>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => openEdit(p)}
                  >
                    {t('settings.editProvider')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    onClick={() => handleRemove(p.id)}
                  >
                    {t('settings.removeProvider')}
                  </button>
                </>
              )}
            </div>
            {editingId === p.id && (
              <div style={{ padding: '16px', border: '1px solid var(--color-border, #ddd)', borderRadius: '8px', marginTop: '8px' }}>
                <label className="form-field">
                  <span>{t('settings.providerName')}</span>
                  <input className="input" value={editName} onChange={(ev) => setEditName(ev.target.value)} disabled={saving} />
                </label>
                <label className="form-field" style={{ marginTop: '8px' }}>
                  <span>{t('settings.providerHarness')}</span>
                  <select className="select" value={editHarness} onChange={(ev) => setEditHarness(ev.target.value)} disabled={saving}>
                    {PROVIDER_HARNESS_OPTIONS.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field" style={{ marginTop: '8px' }}>
                  <span>{t('settings.providerBaseUrl')}</span>
                  <input className="input" value={editBaseUrl} onChange={(ev) => setEditBaseUrl(ev.target.value)} placeholder={DEFAULT_BASE_URL_BY_HARNESS[editHarness] ?? 'https://...'} disabled={saving} />
                </label>
                <p className="page__sub" style={{ margin: '4px 0 0' }}>{t('settings.providerBaseUrlHint')}</p>
                <label className="form-field" style={{ marginTop: '8px' }}>
                  <span>{t('settings.providerApiKeySource')}</span>
                  <input className="input" value={editApiKeySource} onChange={(ev) => setEditApiKeySource(ev.target.value)} disabled={saving} />
                </label>
                {p.apiKeySource && (
                  <p className="page__sub" style={{ margin: '4px 0 0' }}>
                    {p.apiKeyConfigured ? t('settings.providerKeyConfigured') : t('settings.providerKeyMissing')}
                    {p.apiKeyLast4 && <> · ••••{p.apiKeyLast4}</>}
                  </p>
                )}
                <div className="btn-row mt-14">
                  <button type="button" className="btn btn--primary btn--small" disabled={saving || !editName.trim()} onClick={handleEditSave}>
                    {saving ? t('settings.savingIntegration') : t('common.save')}
                  </button>
                  <button type="button" className="btn btn--small" onClick={() => setEditingId(null)} disabled={saving}>
                    {t('settings.cancel')}
                  </button>
                </div>
              </div>
            )}
            {modelsExpandedId === p.id && (
              <div style={{ padding: '12px 16px', border: '1px solid var(--color-border, #ddd)', borderRadius: '8px', marginTop: '8px' }}>
                <div style={{ fontSize: '0.85em', color: 'var(--color-text-muted, #666)', marginBottom: '8px' }}>{t('settings.modelListPerLine')}</div>
                <textarea
                  className="input"
                  rows={Math.max(3, (providerModels[p.id] ?? []).length + 1)}
                  value={getModelEditValue(p.id)}
                  onChange={(ev) => setModelEditValues((prev) => ({ ...prev, [p.id]: ev.target.value }))}
                  disabled={modelSaving === p.id}
                  style={{ fontFamily: 'monospace', fontSize: '0.85em', width: '100%', resize: 'vertical' }}
                />
                <div className="btn-row" style={{ marginTop: '8px' }}>
                  <button type="button" className="btn btn--small btn--primary" onClick={() => handleModelSave(p.id)} disabled={modelSaving === p.id}>
                    {modelSaving === p.id ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </div>
            )}
            </Fragment>
          ))}
        </div>
      )}

      <div className="btn-row mt-14">
        <button type="button" className="btn" onClick={() => setShowAddForm(!showAddForm)}>
          {t('settings.addProvider')}
        </button>
      </div>

      {showAddForm && (
        <div style={{ marginTop: '16px', padding: '16px', border: '1px solid var(--color-border, #ddd)', borderRadius: '8px' }}>
          <label className="form-field">
            <span>{t('settings.providerId')}</span>
            <input
              className="input"
              value={newId}
              onChange={(ev) => setNewId(ev.target.value)}
              autoComplete="off"
              disabled={saving}
            />
          </label>
          <label className="form-field" style={{ marginTop: '8px' }}>
            <span>{t('settings.providerName')}</span>
            <input
              className="input"
              value={newName}
              onChange={(ev) => setNewName(ev.target.value)}
              autoComplete="off"
              disabled={saving}
            />
          </label>
          <label className="form-field" style={{ marginTop: '8px' }}>
            <span>{t('settings.providerHarness')}</span>
            <select
              className="select"
              value={newHarness}
              onChange={(ev) => setNewHarness(ev.target.value)}
              disabled={saving}
            >
              {PROVIDER_HARNESS_OPTIONS.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </label>
          <label className="form-field" style={{ marginTop: '8px' }}>
            <span>{t('settings.providerBaseUrl')}</span>
            <input
              className="input"
              value={newBaseUrl}
              onChange={(ev) => setNewBaseUrl(ev.target.value)}
              placeholder={DEFAULT_BASE_URL_BY_HARNESS[newHarness] ?? 'https://...'}
              autoComplete="off"
              disabled={saving}
            />
          </label>
          <p className="page__sub" style={{ margin: '4px 0 0' }}>{t('settings.providerBaseUrlHint')}</p>
          <label className="form-field" style={{ marginTop: '8px' }}>
            <span>{t('settings.providerApiKeySource')}</span>
            <input
              className="input"
              value={newApiKeySource}
              onChange={(ev) => setNewApiKeySource(ev.target.value)}
              autoComplete="off"
              disabled={saving}
            />
          </label>

          <div className="btn-row mt-14">
            <button type="button" className="btn btn--primary" disabled={saving} onClick={handleAdd}>
              {saving ? t('settings.savingIntegration') : t('settings.addProvider')}
            </button>
            <button type="button" className="btn btn--small" onClick={() => setShowAddForm(false)} disabled={saving}>
              {t('settings.cancel')}
            </button>
          </div>
        </div>
      )}

      {notice && <p className="mt-14" style={{ fontSize: '0.9em' }}>{notice}</p>}
    </section>
  );
}



function TypesafeSection() {
  const { t } = useLocale();
  const [apiKey, setApiKeyState] = useState('');
  const [masked, setMasked] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.typesafe);
  useEffect(() => {
    if (settingsView.data) setMasked(settingsView.data.typesafe.typesafe_api_key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  async function handleSave() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setNotice(null);
    try {
      const result = await setTypesafeApiKey(apiKey.trim());
      setMasked(result);
      setApiKeyState('');
      setNotice('保存しました');
    } catch (error) {
      console.error("Settings request failed", error);
      setNotice('保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="sec-api-keys" style={{ marginTop: '24px' }}>
      <h2 className="panel__title" id="sec-api-keys">API Keys</h2>
      <p className="page__sub" style={{ marginBottom: '16px' }}>外部サービスのAPIキー設定</p>
      <div style={{ maxWidth: '480px' }}>
        <label className="form-field">
          <span>Typesafe API Key</span>
          <input
            className="input"
            type="password"
            value={apiKey}
            onChange={(ev) => setApiKeyState(ev.target.value)}
            placeholder={masked || 'ts-...'}
            autoComplete="off"
            disabled={saving}
          />
          {masked && <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted, #666)', marginTop: '4px' }}>Current: {masked}</span>}
        </label>
        <div className="btn-row" style={{ marginTop: '12px' }}>
          <button type="button" className="btn btn--primary btn--small" onClick={handleSave} disabled={saving || !apiKey.trim()}>
            {saving ? '保存中...' : '保存'}
          </button>
          {notice && <span className="note note--success">{notice}</span>}
        </div>
      </div>
    </section>
  );
}


type IntegrationProvider = 'slack' | 'discord';

const SLACK_MANIFEST = `_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: owl-agent
  description: AI multi-agent orchestration advisor
  background_color: "#6366f1"
features:
  bot_user:
    display_name: owl-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - groups:history
      - groups:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false`;


function IntegrationsSection() {
  const { t } = useLocale();
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [editing, setEditing] = useState<IntegrationProvider | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string } | null>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [conversationChannelId, setConversationChannelId] = useState('');
  const [notificationChannelId, setNotificationChannelId] = useState('');

  const settingsView = useSettings();

  const savedKey = JSON.stringify(settingsView.data?.integrations);
  useEffect(() => {
    if (settingsView.data) setIntegrations(settingsView.data.integrations.integrations);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    if (settingsView.error && !settingsView.data) console.error(settingsView.error);
  }, [settingsView.error, settingsView.data]);

  const getStatus = (provider: IntegrationProvider) =>
    integrations.find((i) => i.provider === provider) ?? {
      provider,
      configured: false,
      conversation_channel_id: null,
      notification_channel_id: null,
      last_tested_at: null,
      last_test_ok: null,
    };

  async function handleTest(provider: IntegrationProvider) {
    setTesting(provider);
    setTestResult((prev) => ({ ...prev, [provider]: null }));
    try {
      const result = await testIntegration(provider);
      setTestResult((prev) => ({ ...prev, [provider]: { ok: result.ok, detail: result.detail } }));
      await settingsView.refresh();
    } catch (error) {
      setTestResult((prev) => ({ ...prev, [provider]: { ok: false, detail: String(error) } }));
    } finally {
      setTesting(null);
    }
  }

  async function handleSave(provider: IntegrationProvider) {
    if (!botToken.trim() && !getStatus(provider).configured) return;
    if (!conversationChannelId.trim() || !notificationChannelId.trim()) {
      setNotice(t('settings.channelsRequired'));
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const config: {
        bot_token?: string;
        app_token?: string;
        signing_secret?: string;
        conversation_channel_id: string;
        notification_channel_id: string;
      } = {
        conversation_channel_id: conversationChannelId.trim(),
        notification_channel_id: notificationChannelId.trim(),
      };
      if (botToken.trim()) config.bot_token = botToken.trim();
      if (provider === 'slack') {
        if (appToken.trim()) config.app_token = appToken.trim();
        if (signingSecret.trim()) config.signing_secret = signingSecret.trim();
      }
      await saveIntegration(provider, config);
      await settingsView.refresh();
      setEditing(null);
      setBotToken('');
      setAppToken('');
      setSigningSecret('');
      setConversationChannelId('');
      setNotificationChannelId('');
      setNotice(t('settings.integrationSaved'));
    } catch (error) {
      console.error("Settings request failed", error);
      setNotice(t('settings.integrationError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect(provider: IntegrationProvider) {
    if (!confirm(t('settings.disconnectConfirm'))) return;
    try {
      await deleteIntegration(provider);
      await settingsView.refresh();
      setTestResult((prev) => ({ ...prev, [provider]: null }));
      setNotice(t('settings.integrationDeleted'));
    } catch (error) {
      console.error("Settings request failed", error);
      setNotice(t('settings.integrationError'));
    }
  }

  function openWizard(provider: IntegrationProvider) {
    setEditing(provider);
    setBotToken('');
    setAppToken('');
    setSigningSecret('');
    const status = getStatus(provider);
    setConversationChannelId(status.conversation_channel_id ?? '');
    setNotificationChannelId(status.notification_channel_id ?? '');
    setNotice(null);
  }

  async function handleCopyManifest() {
    try {
      await navigator.clipboard.writeText(SLACK_MANIFEST);
      setCopied('manifest');
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard API unavailable */ }
  }


  function renderCard(provider: IntegrationProvider) {
    const status = getStatus(provider);
    const icon = provider === 'slack' ? '\u{1F4AC}' : '\u{1F3AE}';
    const title = t('settings.' + provider + 'Integration');
    const desc = t('settings.' + provider + 'Description');
    const test = testResult[provider];

    return (
      <div className="row" key={provider} style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '1.5rem' }}>{icon}</span>
          <div className="row__main" style={{ flex: 1 }}>
            <div className="row__title">{title}</div>
            <div className="row__sub">{desc}</div>
          </div>
          <span className={'note' + (status.configured ? ' note--success' : '')} style={{ whiteSpace: 'nowrap' }}>
            {status.configured ? '\u25CF ' + t('settings.configured') : t('settings.notConfigured')}
          </span>
        </div>
        <div className="btn-row" style={{ marginLeft: '2.5rem' }}>
          {status.configured && (
            <>
              <button type="button" className="btn btn--small" onClick={() => handleTest(provider)} disabled={testing === provider}>
                {testing === provider ? t('settings.testing') : t('settings.testConnection')}
              </button>
              <button type="button" className="btn btn--small btn--danger" onClick={() => handleDisconnect(provider)}>
                {t('settings.disconnect')}
              </button>
            </>
          )}
          <button type="button" className="btn btn--small btn--primary" onClick={() => openWizard(provider)}>
            {t('settings.configure')}
          </button>
        </div>
        {test && (
          <div className={'note ' + (test.ok ? 'note--success' : 'note--error')} style={{ marginLeft: '2.5rem' }}>
            {test.ok ? t('settings.testSuccess') : t('settings.testFailed') + ': ' + test.detail}
          </div>
        )}
        {editing === provider && (
          <div style={{ marginLeft: '2.5rem', padding: '12px', border: '1px solid var(--color-border)', borderRadius: '8px' }}>
            <div style={{ padding: '10px 12px', background: 'var(--color-surface-alt, #f5f5f5)', borderRadius: '6px', marginBottom: '12px', fontSize: '0.85rem', lineHeight: '1.5' }}>
              <strong>{t('settings.' + provider + 'SetupGuide')}</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
                {provider === 'slack' ? (
                  <>
                    <li>{t('settings.slackScopes')}</li>
                    <li>{t('settings.slackAppSettings')}</li>
                    <li>{t('settings.slackAppTokenScope')}</li>
                    <li style={{ listStyle: 'none', marginLeft: '-18px', marginTop: '8px' }}>
                      <button type="button" className="btn btn--small" onClick={handleCopyManifest} style={{ fontSize: '0.8rem' }}>
                        {copied === 'manifest' ? t('settings.copiedManifest') : t('settings.copyManifest')}
                      </button>
                      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginLeft: '8px' }}>
                        {t('settings.slackManifestHint')}
                      </span>
                    </li>
                  </>
                ) : (
                  <>
                    <li>{t('settings.discordPermissions')}</li>
                    <li>{t('settings.discordIntents')}</li>

                  </>
                )}
              </ul>
            </div>
            <label className="form-field">
              <span>{t('settings.conversationChannelId')}</span>
              <textarea
                className="input"
                rows={2}
                value={conversationChannelId}
                onChange={(ev) => setConversationChannelId(ev.target.value)}
                placeholder={t(provider === 'discord' ? 'settings.discordChannelIdPlaceholder' : 'settings.channelIdPlaceholder')}
                autoComplete="off"
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{t('settings.conversationChannelIdHint')}</span>
            </label>
            <label className="form-field" style={{ marginTop: '8px' }}>
              <span>{t('settings.notificationChannelId')}</span>
              <textarea
                className="input"
                rows={2}
                value={notificationChannelId}
                onChange={(ev) => setNotificationChannelId(ev.target.value)}
                placeholder={t(provider === 'discord' ? 'settings.discordChannelIdPlaceholder' : 'settings.channelIdPlaceholder')}
                autoComplete="off"
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>{t('settings.notificationChannelIdHint')}</span>
            </label>
            <label className="form-field" style={{ marginTop: '8px' }}>
              <span>{t('settings.botToken')}</span>
              <input
                className="input"
                type="password"
                value={botToken}
                onChange={(ev) => setBotToken(ev.target.value)}
                placeholder={status.configured ? t('settings.tokenSaved') : t('settings.' + provider + 'BotTokenHint')}
                autoComplete="off"
              />
            </label>
            {provider === 'slack' && (
              <>
                <label className="form-field" style={{ marginTop: '8px' }}>
                  <span>{t('settings.appToken')}</span>
                  <input
                    className="input"
                    type="password"
                    value={appToken}
                    onChange={(ev) => setAppToken(ev.target.value)}
                    placeholder={status.configured ? t('settings.tokenSaved') : t('settings.slackAppTokenHint')}
                    autoComplete="off"
                  />
                </label>
                <label className="form-field" style={{ marginTop: '8px' }}>
                  <span>{t('settings.signingSecret')}</span>
                  <input
                    className="input"
                    type="password"
                    value={signingSecret}
                    onChange={(ev) => setSigningSecret(ev.target.value)}
                    autoComplete="off"
                  />
                </label>
              </>
            )}

            <div className="btn-row" style={{ marginTop: '12px' }}>
              <button
                type="button"
                className="btn btn--primary btn--small"
                onClick={() => handleSave(provider)}
                disabled={saving || (!botToken.trim() && !getStatus(provider).configured) || !conversationChannelId.trim() || !notificationChannelId.trim()}
              >
                {saving ? t('settings.savingIntegration') : t('settings.saveIntegration')}
              </button>
              <button type="button" className="btn btn--small" onClick={() => setEditing(null)}>
                {t('settings.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="panel" aria-labelledby="sec-integrations" style={{ marginTop: '24px' }}>
      <h2 className="panel__title" id="sec-integrations">
        {t('settings.integrations')}
      </h2>
      <p className="page__sub" style={{ marginBottom: '16px' }}>
        {t('settings.integrationsSubtitle')}
      </p>
      {notice && <div className="note note--success" style={{ marginBottom: '12px' }}>{notice}</div>}
      <div className="list">
        {renderCard('slack')}
        {renderCard('discord')}
      </div>
    </section>
  );
}
