'use client';

import { useEffect, useState } from 'react';
import {
  approveRuleProposal,
  listRuleProposals,
  rejectRuleProposal,
} from '@/lib/api-client';
import { useView } from '@/lib/view-loader';
import type { RuleProposal, RuleProposalCommandResult, RuleProposalStatus } from '@/lib/types';
import { useLocale, type TFunction } from '@/lib/i18n';

type ProposalListStatus = Extract<RuleProposalStatus, 'awaiting_approval' | 'pending'>;

function errorField(error: unknown, key: 'code' | 'kind'): string {
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const value = (error as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  }
  return '';
}

export function RuleApprovalsView() {
  const { t } = useLocale();
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [outcomeBanner, setOutcomeBanner] = useState<string | null>(null);
  const [status, setStatus] = useState<ProposalListStatus>('awaiting_approval');

  const view = useView(`rule-proposals:${status}`, () => listRuleProposals(status));
  const proposals = view.data ?? null;
  const loadError = view.error ? t('rules.approvals.loadError') : null;
  const retry = () => void view.refresh();

  useEffect(() => {
    if (view.error) console.error('[Owl] Rule proposals load error', view.error);
  }, [view.error]);

  useEffect(() => {
    const queryStatus = new URLSearchParams(window.location.search).get('status');
    if (queryStatus === 'pending') setStatus('pending');
  }, []);

  function classifyError(error: unknown): string {
    const code = errorField(error, 'code');
    const kind = errorField(error, 'kind');
    if (code === 'invalid_state_transition') return t('rules.approvals.errorInvalidStateTransition');
    if (code === 'dependency_unavailable') return t('rules.approvals.errorDependencyUnavailable');
    if (kind === 'network_error') return t('rules.approvals.errorNetwork');
    return t('rules.approvals.errorDefault');
  }

  function outcomeText(result: RuleProposalCommandResult): string {
    return result.status === 'applied'
      ? t('rules.approvals.resultApplied')
      : t('rules.approvals.resultRejected');
  }

  async function runCommand(proposal: RuleProposal, action: 'approve' | 'reject') {
    setBusyIds((previous) => new Set(previous).add(proposal.id));
    setCardErrors((previous) => ({ ...previous, [proposal.id]: '' }));
    try {
      const result = action === 'approve'
        ? await approveRuleProposal(proposal.id)
        : await rejectRuleProposal(proposal.id);
      setOutcomeBanner(outcomeText(result));
      retry();
    } catch (error) {
      setCardErrors((previous) => ({ ...previous, [proposal.id]: classifyError(error) }));
      if (errorField(error, 'code') === 'invalid_state_transition') retry();
      console.error(`[Owl] Rule proposal ${action} error`, error);
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous);
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
              ? t('rules.approvals.titleLoading')
              : t('rules.approvals.title', { count: String(proposals.length) })}
          </h1>
          <p className="page__sub">
            {status === 'pending' ? t('rules.approvals.pendingSubtitle') : t('rules.approvals.subtitle')}
          </p>
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

      {proposals !== null && proposals.length === 0 && !loadError && (
        <p className="empty">{status === 'pending' ? t('rules.approvals.emptyPending') : t('rules.approvals.empty')}</p>
      )}

      {proposals !== null && proposals.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              canAct={status === 'awaiting_approval' && proposal.status === 'awaiting_approval'}
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
  canAct,
  busy,
  error,
  onApprove,
  onReject,
  t,
}: {
  proposal: RuleProposal;
  canAct: boolean;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onReject: () => void;
  t: TFunction;
}) {
  return (
    <article className="card">
      <div className="proposal-card__head">
        <span className="badge badge--amber">{t(`rules.approvals.origin.${proposal.origin}`)}</span>
        <span className="mono">{proposal.id}</span>
      </div>
      <div className="proposal-diff">
        <div className="proposal-diff__head">{t('rules.approvals.textLabel')}</div>
        <pre className="proposal-diff__body">{proposal.text}</pre>
      </div>
      <div className="proposal-judgement">
        <div className="proposal-judgement__tile">
          <div className="proposal-judgement__label">{t('rules.approvals.scopeLabel')}</div>
          <div className="proposal-judgement__value">
            {proposal.level === 'role'
              ? t('rules.approvals.roleScope', { role: proposal.role ?? '' })
              : t('rules.approvals.systemScope')}
          </div>
        </div>
        <div className="proposal-judgement__tile">
          <div className="proposal-judgement__label">{t('rules.approvals.sourceCountLabel')}</div>
          <div className="proposal-judgement__value">{proposal.source_count}</div>
        </div>
        <div className="proposal-judgement__tile">
          <div className="proposal-judgement__label">{t('rules.approvals.sourceWorkLabel', { count: String(proposal.source_work_ids.length) })}</div>
          <div className="proposal-judgement__value">
            {proposal.source_work_ids.length > 0 ? proposal.source_work_ids.join(', ') : t('rules.approvals.noWorkSources')}
          </div>
        </div>
        {proposal.note_id && (
          <div className="proposal-judgement__tile">
            <div className="proposal-judgement__label">{t('rules.approvals.sourceNoteLabel')}</div>
            <div className="proposal-judgement__value">{proposal.note_id}</div>
          </div>
        )}
      </div>
      <p className="note">{t('rules.approvals.reasonFormat', { reason: proposal.rationale || t('rules.approvals.noReason') })}</p>
      <p className="note">{t('rules.approvals.appliesToFormat', { appliesTo: proposal.applies_to || t('rules.approvals.unspecified') })}</p>
      {proposal.last_error && (
        <div className="error" role="alert">{t('rules.approvals.lastError', { error: proposal.last_error })}</div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {canAct && (
        <div className="btn-row mt-10">
          <button type="button" className="btn" disabled={busy} onClick={onReject}>
            {t('rules.approvals.rejectButton')}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={onApprove}>
            {busy ? t('rules.approvals.pending') : t('rules.approvals.approveButton')}
          </button>
        </div>
      )}
    </article>
  );
}
