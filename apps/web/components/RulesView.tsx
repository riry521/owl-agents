'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { getRules, checkRule, listRuleProposals, type RulesSnapshot } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useLocale } from '@/lib/i18n';

interface CheckResult {
  blocked: boolean;
  rule?: { id: string; level: string; message: string };
}

const LEVEL_COLORS: Record<string, string> = {
  absolute: 'var(--red)',
  system: 'var(--amber)',
  role: 'var(--accent)',
  work: 'var(--green)',
};

function LevelBadge({ level }: { level: string }) {
  return <span className="rules-badge" style={{ background: LEVEL_COLORS[level] ?? 'var(--muted)' }}>{level}</span>;
}

export default function RulesView() {
  const { locale, t } = useLocale();
  const [data, setData] = useState<RulesSnapshot | null>(null);
  const [error, setError] = useState('');
  const [checkCmd, setCheckCmd] = useState('');
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingProposals, setPendingProposals] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await getRules());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    void listRuleProposals('awaiting_approval')
      .then((proposals) => setPendingProposals(proposals.length))
      .catch((e) => console.error('[Owl] Rule approval count load error', e));
  }, []);

  const handleCheck = async () => {
    if (!checkCmd.trim()) return;
    setChecking(true);
    try {
      const res = await checkRule(checkCmd);
      setCheckResult(res as CheckResult);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="empty">{t('rules.loadingText')}</p>;

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('rules.title')}</h1>
          <p className="page__sub">{t('rules.subtitle')}</p>
        </div>
      </div>

      {pendingProposals > 0 && (
        <Link href="/rules/approvals" className="skills-banner">
          <span>{t('rules.approvals.banner', { count: String(pendingProposals) })}</span>
          <span className="skills-banner__hint">{t('rules.approvals.bannerHint')}</span>
          <span className="skills-banner__spacer" />
          <strong className="skills-banner__cta">{t('rules.approvals.bannerCta')}</strong>
          <span className="skills-banner__chevron" aria-hidden="true">›</span>
        </Link>
      )}

      {data.status.error && (
        <div className="rules-check__result rules-check__result--blocked" style={{ marginBottom: '1.2rem' }}>
          <p>{t('rules.reloadFailed', { at: formatDateTime(data.status.error.at, locale) })}</p>
          <ul>
            {data.status.error.failures.map((f) => (
              <li key={`${f.path}:${f.line ?? ''}:${f.reason}`}>
                <code>{f.path}{f.line !== null ? `:${f.line}` : ''}</code> {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.status.loaded_at && (
        <p style={{ color: 'var(--muted)', marginBottom: '1.2rem' }}>
          {t('rules.loadedAt', { at: formatDateTime(data.status.loaded_at, locale), generation: String(data.status.generation) })}
        </p>
      )}

      {/* Command Check */}
      <div className="rules-check">
        <h2 className="rules-section-title">{t('rules.commandCheck')}</h2>
        <div className="rules-check__form">
          <input
            className="rules-check__input"
            placeholder={t('rules.inputPlaceholder')}
            value={checkCmd}
            onChange={(e) => { setCheckCmd(e.target.value); setCheckResult(null); }}
            onKeyDown={(e) => e.key === 'Enter' && handleCheck()}
          />
          <button className="rules-check__btn" onClick={handleCheck} disabled={checking || !checkCmd.trim()}>
            {checking ? '...' : t('rules.check')}
          </button>
        </div>
        {checkResult && (
          <div className={`rules-check__result ${checkResult.blocked ? 'rules-check__result--blocked' : 'rules-check__result--ok'}`}>
            {checkResult.blocked
              ? <>{'✗'} {t('rules.blocked', { message: checkResult.rule?.message ?? '' })}</>
              : <>{'✓'} {t('rules.allowed')}</>}
          </div>
        )}
      </div>

      {/* Block Rules */}
      <div className="rules-section">
        <h2 className="rules-section-title">{t('rules.blockRules', { count: String(data.block_rules.length) })}</h2>
        <table className="rules-table">
          <thead>
            <tr><th>{t('rules.thId')}</th><th>{t('rules.thLevel')}</th><th>{t('rules.thRole')}</th><th>{t('rules.thPattern')}</th><th>{t('rules.thMessage')}</th></tr>
          </thead>
          <tbody>
            {data.block_rules.map((r) => (
              <tr key={r.id}>
                <td><code>{r.id}</code></td>
                <td><LevelBadge level={r.level} /></td>
                <td>{r.role ?? t('rules.allRoles')}</td>
                <td><code>{r.pattern}</code></td>
                <td>{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Block Paths */}
      <div className="rules-section">
        <h2 className="rules-section-title">{t('rules.blockPaths', { count: String(data.block_paths.length) })}</h2>
        <table className="rules-table">
          <thead>
            <tr><th>{t('rules.thId')}</th><th>{t('rules.thLevel')}</th><th>{t('rules.thRole')}</th><th>{t('rules.thPattern')}</th><th>{t('rules.thMode')}</th><th>{t('rules.thMessage')}</th></tr>
          </thead>
          <tbody>
            {data.block_paths.map((r) => (
              <tr key={r.id}>
                <td><code>{r.id}</code></td>
                <td><LevelBadge level={r.level} /></td>
                <td>{r.role ?? t('rules.allRoles')}</td>
                <td><code>{r.pattern}</code></td>
                <td data-label={t('rules.thMode')}>{r.mode}</td>
                <td>{r.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Instructions */}
      <div className="rules-section">
        <h2 className="rules-section-title">{t('rules.instructions', { count: String(data.prompt_rules.length) })}</h2>
        <table className="rules-table">
          <thead>
            <tr><th>{t('rules.thId')}</th><th>{t('rules.thLevel')}</th><th>{t('rules.thRole')}</th><th>{t('rules.thMessage')}</th></tr>
          </thead>
          <tbody>
            {data.prompt_rules.map((r) => (
              <tr key={`${r.level}:${r.role ?? ''}:${r.id}`}>
                <td><code>{r.id}</code></td>
                <td><LevelBadge level={r.level} /></td>
                <td>{r.role ?? t('rules.allRoles')}</td>
                <td>{r.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Loaded Files */}
      <div className="rules-section">
        <h2 className="rules-section-title">{t('rules.loadedFiles', { count: String(data.files.length) })}</h2>
        <ul className="rules-files">
          {data.files.map((f) => (
            <li key={f.path}>
              <LevelBadge level={f.level} />
              {f.role && <span className="rules-file-count">{f.role}</span>}
              <code>{f.path.split('/').pop()}</code>
              <span className="rules-file-count">{t('rules.ruleCount', { count: String(f.rule_count) })}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
