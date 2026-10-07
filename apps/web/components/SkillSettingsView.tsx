'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getProcessSkillsSettings,
  getSkillSettings,
  getTypesafeApiKey,
  setProcessSkillsSettings,
  setSkillSettings,
} from '@/lib/api-client';
import type { ProcessSkillsSettingsData, SkillSettings, SkillSettingsMode } from '@/lib/types';
import { useLocale, type TFunction } from '@/lib/i18n';

type IntegerField = 'stale_days' | 'archived_days' | 'max_items' | 'max_characters';

const INTEGER_LIMITS: Record<IntegerField, { min: number; max: number; labelKey: string }> = {
  stale_days: { min: 1, max: 3650, labelKey: 'skills.settings.staleDaysLabel' },
  archived_days: { min: 1, max: 3650, labelKey: 'skills.settings.archivedDaysLabel' },
  max_items: { min: 1, max: 1000, labelKey: 'skills.settings.maxItemsLabel' },
  max_characters: { min: 1, max: 1000000, labelKey: 'skills.settings.maxCharsLabel' },
};

function validateSettings(settings: SkillSettings, t: TFunction): string | null {
  for (const field of Object.keys(INTEGER_LIMITS) as IntegerField[]) {
    const { min, max, labelKey } = INTEGER_LIMITS[field];
    const value = settings[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      return t('skills.settings.rangeError', { label: t(labelKey), min: String(min), max: String(max) });
    }
  }
  return null;
}

export function SkillSettingsView() {
  const { t } = useLocale();
  const [settings, setSettings] = useState<SkillSettings | null>(null);
  const [version, setVersion] = useState(0);
  const [processSettings, setProcessSettingsState] = useState<ProcessSkillsSettingsData | null>(null);
  const [typesafeConfigured, setTypesafeConfigured] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [copiedInstallCommand, setCopiedInstallCommand] = useState<string | null>(null);
  const copiedResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [skillSettings, processSkills, typesafeKey] = await Promise.all([
        getSkillSettings(),
        getProcessSkillsSettings(),
        getTypesafeApiKey().catch((error) => {
          console.error('Failed to load Typesafe API key status', error);
          return '';
        }),
      ]);
      setSettings(skillSettings.settings);
      setVersion(skillSettings.version);
      setProcessSettingsState(processSkills);
      setTypesafeConfigured(typesafeKey.trim().length > 0);
    } catch (e) {
      setLoadError(t('skills.settings.loadError'));
      console.error('[Owl] Skill settings load error', e);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    if (!settings || !processSettings) return;
    setSaveOk(false);
    const invalid = validateSettings(settings, t);
    if (invalid) {
      setSaveError(invalid);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      try {
        const savedSkillSettings = await setSkillSettings(settings, version);
        setSettings(savedSkillSettings.settings);
        setVersion(savedSkillSettings.version);
      } catch (e) {
        setSaveError(t('skills.settings.saveError'));
        console.error('[Owl] Skill settings save error', e);
        return;
      }
      try {
        const savedProcessSettings = await setProcessSkillsSettings({
          enabled: processSettings.enabled,
          path: processSettings.path,
        });
        setProcessSettingsState(savedProcessSettings);
      } catch (e) {
        setSaveError(t('skills.settings.processSaveError'));
        console.error('[Owl] Process skills settings save error', e);
        return;
      }
      setSaveOk(true);
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !processSettings) {
    return (
      <>
        <div className="crumbs">
          <Link href="/skills">{t('skills.list.title')}</Link>
          <span>/</span>
          <strong>{t('skills.settings.breadcrumb')}</strong>
        </div>
        {loadError ? <div className="error">{loadError}</div> : <p className="empty">{t('common.loading')}</p>}
      </>
    );
  }

  const setMode = (mode: SkillSettingsMode) => setSettings({ ...settings, mode });

  async function handleCopyInstallCommand(harness: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedInstallCommand(harness);
      if (copiedResetTimer.current !== null) clearTimeout(copiedResetTimer.current);
      copiedResetTimer.current = setTimeout(() => {
        copiedResetTimer.current = null;
        setCopiedInstallCommand(null);
      }, 2000);
    } catch { /* clipboard API unavailable */ }
  }

  return (
    <>
      <div className="crumbs">
        <Link href="/skills">{t('skills.list.title')}</Link>
        <span>/</span>
        <strong>{t('skills.settings.breadcrumb')}</strong>
      </div>

      <div className="page__head">
        <div>
          <h1 className="page__title">{t('skills.settings.title')}</h1>
          <p className="page__sub">{t('skills.settings.subtitle')}</p>
        </div>
        <button type="button" className="btn btn--primary" disabled={saving} onClick={() => void handleSave()}>
          {saving ? t('skills.settings.saving') : t('skills.settings.saveButton')}
        </button>
      </div>

      {loadError && <div className="error">{loadError}</div>}
      {saveError && <div className="error" role="alert">{saveError}</div>}
      {saveOk && <div className="note" role="status">{t('skills.settings.saveSuccess')}</div>}

      <section className="panel">
        <h2 className="panel__title" id="skill-mode-title">{t('skills.settings.modeTitle')}</h2>
        <div className="radio-card-group" role="radiogroup" aria-labelledby="skill-mode-title">
          <label className={`radio-card${settings.mode === 'autonomous' ? ' radio-card--selected' : ''}`}>
            <input
              type="radio"
              name="skill-mode"
              checked={settings.mode === 'autonomous'}
              onChange={() => setMode('autonomous')}
            />
            <span>
              <span className="radio-card__title">
                {t('skills.settings.modeAutonomous')}
                <span className="badge badge--accent">{t('skills.settings.modeAutonomousRecommended')}</span>
              </span>
              <span className="radio-card__desc">{t('skills.settings.modeAutonomousDesc')}</span>
            </span>
          </label>
          <label className={`radio-card${settings.mode === 'conservative' ? ' radio-card--selected' : ''}`}>
            <input
              type="radio"
              name="skill-mode"
              checked={settings.mode === 'conservative'}
              onChange={() => setMode('conservative')}
            />
            <span>
              <span className="radio-card__title">{t('skills.settings.modeConservative')}</span>
              <span className="radio-card__desc">{t('skills.settings.modeConservativeDesc')}</span>
            </span>
          </label>
        </div>
        <div className="note">{t('skills.settings.modeScriptsNote')}</div>
      </section>

      <section className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 className="panel__title" style={{ margin: 0 }}>{t('skills.settings.judgementTitle')}</h2>
          <span className="card__spacer" />
          <span className={`badge ${typesafeConfigured ? 'badge--green' : 'badge--gray'}`}>
            {typesafeConfigured
              ? t('skills.settings.judgementTypesafeConfigured')
              : t('skills.settings.judgementTypesafeNotConfigured')}
          </span>
        </div>
        <p className="note">{t('skills.settings.judgementHint')}</p>
        <label className="form-field form-field--short">
          <span>{t('skills.settings.confidenceLabel')}</span>
          <div className="range-row">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.confidence_threshold}
              onChange={(e) => setSettings({ ...settings, confidence_threshold: Number(e.target.value) })}
            />
            <span className="range-row__value">{settings.confidence_threshold.toFixed(2)}</span>
          </div>
          <span className="note">{t('skills.settings.confidenceHint')}</span>
        </label>
      </section>

      <section className="panel">
        <h2 className="panel__title">{t('skills.settings.metabolismTitle')}</h2>
        <div className="form-grid">
          <label className="form-field form-field--short">
            <span>{t('skills.settings.staleDaysLabel')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                className="input"
                style={{ width: 80 }}
                min={INTEGER_LIMITS.stale_days.min}
                max={INTEGER_LIMITS.stale_days.max}
                step={1}
                required
                value={Number.isNaN(settings.stale_days) ? '' : settings.stale_days}
                onChange={(e) => setSettings({ ...settings, stale_days: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
              />
              <span className="note">{t('skills.settings.staleDaysUnit')}</span>
            </span>
          </label>
          <label className="form-field form-field--short">
            <span>{t('skills.settings.archivedDaysLabel')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                className="input"
                style={{ width: 80 }}
                min={INTEGER_LIMITS.archived_days.min}
                max={INTEGER_LIMITS.archived_days.max}
                step={1}
                required
                value={Number.isNaN(settings.archived_days) ? '' : settings.archived_days}
                onChange={(e) => setSettings({ ...settings, archived_days: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
              />
              <span className="note">{t('skills.settings.archivedDaysUnit')}</span>
            </span>
          </label>
          <label className="form-field form-field--short">
            <span>{t('skills.settings.maxItemsLabel')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                className="input"
                style={{ width: 80 }}
                min={INTEGER_LIMITS.max_items.min}
                max={INTEGER_LIMITS.max_items.max}
                step={1}
                required
                value={Number.isNaN(settings.max_items) ? '' : settings.max_items}
                onChange={(e) => setSettings({ ...settings, max_items: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
              />
              <span className="note">{t('skills.settings.maxItemsUnit')}</span>
            </span>
          </label>
          <label className="form-field form-field--short">
            <span>{t('skills.settings.maxCharsLabel')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                className="input"
                style={{ width: 80 }}
                min={INTEGER_LIMITS.max_characters.min}
                max={INTEGER_LIMITS.max_characters.max}
                step={1}
                required
                value={Number.isNaN(settings.max_characters) ? '' : settings.max_characters}
                onChange={(e) => setSettings({ ...settings, max_characters: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
              />
              <span className="note">{t('skills.settings.maxCharsUnit')}</span>
            </span>
          </label>
        </div>
        <div className="note">{t('skills.settings.metabolismHint')}</div>
      </section>

      <section className="hybrid-card">
        <div className="hybrid-card__header">
          <div className="hybrid-card__info">
            <div className="hybrid-card__icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
            </div>
            <div>
              <div className="hybrid-card__title">{t('skills.settings.processSkillsTitle')}</div>
              <div className="hybrid-card__desc">{t('skills.settings.processSkillsDescription')}</div>
            </div>
          </div>
          <button
            type="button"
            className={`toggle-switch toggle-switch--${processSettings.enabled ? 'on' : 'off'}`}
            role="switch"
            aria-checked={processSettings.enabled}
            aria-label={t('skills.settings.processSkillsEnable')}
            onClick={() => setProcessSettingsState({ ...processSettings, enabled: !processSettings.enabled })}
          />
        </div>
        {processSettings.enabled && (
          <div className="hybrid-card__executor">
            <label className="form-field">
              <span>{t('skills.settings.processSkillsPathLabel')}</span>
              <input
                className="input"
                value={processSettings.path ?? ''}
                onChange={(e) =>
                  setProcessSettingsState({ ...processSettings, path: e.target.value.trim() === '' ? null : e.target.value })
                }
                placeholder={t('skills.settings.processSkillsPathPlaceholder')}
              />
            </label>
            <div className="detected-pack">
              <strong>{t('skills.settings.processSkillsDetectedLabel')}: </strong>
              {processSettings.detected ? (
                <span>
                  {t('skills.settings.processSkillsDetectedFormat', {
                    source:
                      processSettings.detected.source === 'setting'
                        ? t('skills.settings.processSkillsSourceSetting')
                        : processSettings.detected.source === 'claude'
                          ? t('skills.settings.processSkillsSourceClaude')
                          : t('skills.settings.processSkillsSourceCodex'),
                    version: processSettings.detected.version ?? t('skills.settings.processSkillsDetectedVersionUnknown'),
                    dir: processSettings.detected.skills_dir,
                  })}
                </span>
              ) : (
                <span>{t('skills.settings.processSkillsNotFound')}</span>
              )}
              {!processSettings.detected && (
                <div className="detected-pack__missing">
                  {processSettings.install_commands.map((entry) => (
                    <div className="detected-pack__install-row" key={entry.harness}>
                      <code>{entry.command}</code>
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => void handleCopyInstallCommand(entry.harness, entry.command)}
                      >
                        {copiedInstallCommand === entry.harness
                          ? t('skills.settings.processSkillsCopied')
                          : t('skills.settings.processSkillsCopy')}
                      </button>
                    </div>
                  ))}
                  <div className="note">{t('skills.settings.processSkillsReloadHint')}</div>
                  <div className="note">{t('skills.settings.processSkillsOtherHarnessHint')}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
