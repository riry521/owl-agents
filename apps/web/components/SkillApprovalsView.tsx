'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { approveSkillProposal, listSkillProposals, rejectSkillProposal } from '@/lib/api-client';
import type { SkillProposal, SkillProposalCommandResult } from '@/lib/types';
import { diffFileMaps, formatByteSize } from '@/lib/skill-diff';
import { useLocale, type TFunction } from '@/lib/i18n';
import { SkillFileDiff } from './SkillFileDiff';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function errorField(error: unknown, key: 'code' | 'kind'): string {
  const record = asRecord(error);
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

export function SkillApprovalsView() {
  const { t } = useLocale();
  const [proposals, setProposals] = useState<SkillProposal[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [outcomeBanner, setOutcomeBanner] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const retry = () => setRetryCount((c) => c + 1);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await listSkillProposals('awaiting_approval');
      setProposals(list);
    } catch (e) {
      setLoadError(t('skills.approvals.loadError'));
      console.error('[Owl] Skill proposals load error', e);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load, retryCount]);

  function classifyError(error: unknown): string {
    const code = errorField(error, 'code');
    const kind = errorField(error, 'kind');
    if (code === 'invalid_state_transition') return t('skills.approvals.errorInvalidStateTransition');
    if (code === 'dependency_unavailable') return t('skills.approvals.errorDependencyUnavailable');
    if (kind === 'network_error') return t('skills.approvals.errorNetwork');
    return t('skills.approvals.errorDefault');
  }

  function outcomeText(result: SkillProposalCommandResult): string {
    if (result.status === 'applied') return t('skills.approvals.resultApplied');
    if (result.status === 'rejected') return t('skills.approvals.resultRejected');
    return t('skills.approvals.resultAwaitingApproval');
  }

  async function runCommand(proposal: SkillProposal, action: 'approve' | 'reject') {
    setBusyIds((prev) => new Set(prev).add(proposal.id));
    setCardErrors((prev) => ({ ...prev, [proposal.id]: '' }));
    try {
      if (action === 'approve') {
        const result = await approveSkillProposal(proposal.id);
        setOutcomeBanner(outcomeText(result));
      } else {
        await rejectSkillProposal(proposal.id);
        setOutcomeBanner(t('skills.approvals.rejected'));
      }
      retry();
    } catch (e) {
      setCardErrors((prev) => ({ ...prev, [proposal.id]: classifyError(e) }));
      // The proposal may already have been handled elsewhere; show the latest list.
      if (errorField(e, 'code') === 'invalid_state_transition') retry();
      console.error(`[Owl] Skill proposal ${action} error`, e);
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(proposal.id);
        return next;
      });
    }
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">
            {proposals === null
              ? t('skills.approvals.titleLoading')
              : t('skills.approvals.title', { count: String(proposals.length) })}
          </h1>
          <p className="page__sub">{t('skills.approvals.subtitle')}</p>
        </div>
      </div>

      {outcomeBanner && (
        <div className="note" role="status">
          {outcomeBanner}
          <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => setOutcomeBanner(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      {loadError && (
        <div className="panel">
          <div className="error" role="alert">{loadError}</div>
          <div className="btn-row mt-10">
            <button type="button" className="btn" onClick={retry}>{t('work.retry')}</button>
          </div>
        </div>
      )}

      {proposals === null && !loadError && <p className="empty">{t('common.loading')}</p>}

      {proposals !== null && proposals.length === 0 && !loadError && <p className="empty">{t('skills.approvals.empty')}</p>}

      {proposals !== null && proposals.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              busy={busyIds.has(proposal.id)}
              error={cardErrors[proposal.id] || null}
              onApprove={() => void runCommand(proposal, 'approve')}
              onReject={() => void runCommand(proposal, 'reject')}
              t={t}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ProposalCard({
  proposal,
  busy,
  error,
  onApprove,
  onReject,
  t,
}: {
  proposal: SkillProposal;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  t: TFunction;
}) {
  const payload = asRecord(proposal.payload);
  const decision = asRecord(proposal.decision);
  const judgement = proposal.judgement;
  const isNew = proposal.kind === 'new';
  const name =
    proposal.target_skill ?? recordString(decision, 'target_name') ?? recordString(payload, 'target') ?? '';
  const summary = recordString(payload, 'summary');
  const steps = recordString(payload, 'steps_or_diff');
  const evidence = recordString(payload, 'evidence');
  const reason = judgement.reason;
  const reusability = judgement.reusability;
  const confidence = judgement.confidence;
  const relation = judgement.relation;
  const relationKey = relation ? `skills.approvals.relation.${relation}` : '';
  const relationLabel = relation ? (t(relationKey) === relationKey ? relation : t(relationKey)) : null;
  const source = proposal.source_work_id
    ? t('skills.approvals.sourceWork', { id: proposal.source_work_id })
    : proposal.source_agent_run_id
      ? t('skills.approvals.sourceAgent', { id: proposal.source_agent_run_id })
      : null;

  const written = proposal.written_content;
  const diffs = useMemo(
    () => (written && !isNew ? diffFileMaps(proposal.current_content ?? {}, written) : []),
    [written, isNew, proposal.current_content],
  );

  return (
    <div className="card">
      <div className="proposal-card__head">
        <span className={`badge ${isNew ? 'badge--green' : 'badge--blue'}`}>
          {isNew ? t('skills.approvals.kindNew') : t('skills.approvals.kindUpdate')}
        </span>
        {name && <span className="skill-card__name mono">{name}</span>}
      </div>
      {(reusability !== null || relationLabel || confidence !== null || source) && (
        <div className="proposal-judgement">
          {(reusability !== null || relationLabel) && (
            <div className="proposal-judgement__tile">
              <div className="proposal-judgement__label">{t('skills.approvals.reuseLabel')}</div>
              <div className="proposal-judgement__value">
                {[reusability !== null ? t('skills.approvals.reuseValue', { score: String(reusability) }) : null, relationLabel]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          )}
          {confidence !== null && (
            <div className="proposal-judgement__tile">
              <div className="proposal-judgement__label">{t('skills.approvals.confidenceLabel')}</div>
              <div className="proposal-judgement__value">{confidence.toFixed(2)}</div>
            </div>
          )}
          {source && (
            <div className="proposal-judgement__tile">
              <div className="proposal-judgement__label">{t('skills.approvals.sourceLabel')}</div>
              <div className="proposal-judgement__value">{source}</div>
            </div>
          )}
        </div>
      )}
      {summary && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>{summary}</p>}
      {reason && <p className="note">{t('skills.approvals.reasonFormat', { reason })}</p>}

      {written === null ? (
        <>
          {steps && (
            <div className="proposal-diff">
              <div className="proposal-diff__head">{t('skills.approvals.stepsLabel')}</div>
              <pre className="proposal-diff__body">{steps}</pre>
            </div>
          )}
          {evidence && (
            <p className="note">
              {t('skills.approvals.evidenceLabel')}: {evidence}
            </p>
          )}
          <div className="info-banner">{t('skills.approvals.unwrittenNote')}</div>
        </>
      ) : isNew ? (
        <div className="skill-files">
          {Object.keys(written)
            .sort()
            .map((path) => (
              <div key={path} className="skill-file-row">
                <span className="skill-file-row__path">{path}</span>
                <span className="skill-file-row__size">{formatByteSize(written[path] ?? '')}</span>
              </div>
            ))}
        </div>
      ) : (
        diffs.map((d) => (
          <div key={d.path}>
            <SkillFileDiff diff={d} t={t} headClassName="diff-summary" />
          </div>
        ))
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <div className="btn-row mt-10">
        {!isNew && name && (
          <Link className="btn" href={`/skills/detail?name=${encodeURIComponent(name)}`}>
            {t('skills.approvals.viewButton')}
          </Link>
        )}
        <button type="button" className="btn" disabled={busy} onClick={onReject}>
          {t('skills.approvals.rejectButton')}
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={onApprove}>
          {busy ? t('skills.approvals.pending') : t('skills.approvals.approveButton')}
        </button>
      </div>
    </div>
  );
}
