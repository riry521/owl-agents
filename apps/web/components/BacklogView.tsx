'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiRequestError,
  dismissBacklogItems,
  issueBacklogWork,
  linkBacklogItems,
  getBacklogView,
  listLinkableWorks,
} from '@/lib/api-client';
import type { BacklogItem, BacklogStatus, Project, WorkSummary } from '@/lib/types';
import { backlogLocation, backlogWorkDraft } from '@/lib/backlog-draft.mjs';
import { backlogStatusBadge, showsLinkedWork } from '@/lib/backlog-link.mjs';
import { useLocale } from '@/lib/i18n';
import { useView } from '@/lib/view-loader';

export function BacklogView() {
  const { locale, t } = useLocale();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<BacklogStatus | ''>('open');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [issueOpen, setIssueOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [size, setSize] = useState<'normal' | 'small'>('normal');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkWorkId, setLinkWorkId] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ message: string; workId?: string } | null>(null);

  const offset = 0;
  const { data: view, error: viewError, refresh } = useView(
    `backlog:${projectId || '*'}:${status || '*'}:${offset}`,
    () =>
      getBacklogView({
        ...(status ? { status } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        offset,
      }),
  );
  const items: BacklogItem[] | null = view ? view.items : null;
  const projects: Project[] | null = view ? view.projects : null;
  const loadError = viewError !== null && viewError !== undefined;
  const projectLoadError = false;
  useEffect(() => {
    if (viewError) console.error('[Owl] Backlog load failed', viewError);
  }, [viewError]);

  const retry = () => void refresh();
  const linkProjectId = selectedIds.size > 0 ? ((items ?? []).find((item) => selectedIds.has(item.id))?.project_id ?? null) : null;
  const { data: linkData, error: linkWorksError } = useView<WorkSummary[]>(
    linkOpen ? `linkable-works:${linkProjectId ?? 'null'}` : null,
    () => listLinkableWorks(linkProjectId),
  );
  const linkWorks: WorkSummary[] | null = linkWorksError ? [] : (linkData ?? null);
  useEffect(() => {
    if (!linkWorksError) return;
    console.error('[Owl] Backlog link works load failed', linkWorksError);
    setActionError(t('backlog.link.loadError'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkWorksError]);
  const selectedItems = (items ?? []).filter((item) => selectedIds.has(item.id));
  const selectedProjects = new Set(selectedItems.map((item) => item.project_id));
  const mixedProjects = selectedProjects.size > 1;

  function classifyError(error: unknown): string {
    const code = error instanceof ApiRequestError ? error.code : '';
    const kind = error instanceof ApiRequestError ? error.kind : '';
    if (code === 'invalid_state_transition') return t('backlog.error.invalidState');
    if (code === 'work_not_found') return t('backlog.error.workNotFound');
    if (code === 'backlog_item_not_found') return t('backlog.error.notFound');
    if (code === 'validation_error') return t('backlog.error.validation');
    if (kind === 'network_error') return t('backlog.error.network');
    return t('backlog.error.default');
  }

  function changeProject(value: string) {
    setProjectId(value);
    setSelectedIds(new Set());
    setIssueOpen(false);
    setLinkOpen(false);
    setActionError(null);
  }

  function changeStatus(value: string) {
    setStatus(value as BacklogStatus | '');
    setSelectedIds(new Set());
    setIssueOpen(false);
    setLinkOpen(false);
    setActionError(null);
  }

  function toggleSelection(itemId: string) {
    setIssueOpen(false);
    setLinkOpen(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function dismiss(ids: string[]) {
    if (!window.confirm(t('backlog.dismiss.confirm', { count: String(ids.length) }))) return;
    setBusy(true);
    setActionError(null);
    try {
      await dismissBacklogItems(ids);
      setOutcome({ message: t('backlog.dismissed', { count: String(ids.length) }) });
      setSelectedIds(new Set());
      setIssueOpen(false);
      retry();
    } catch (error) {
      setActionError(classifyError(error));
      if (error instanceof ApiRequestError && (error.code === 'invalid_state_transition' || error.code === 'backlog_item_not_found')) {
        setSelectedIds(new Set());
        retry();
      }
      console.error('[Owl] Backlog dismiss failed', error);
    } finally {
      setBusy(false);
    }
  }

  function openLinkForm() {
    if (mixedProjects) {
      setActionError(t('backlog.link.mixedProjects'));
      return;
    }
    setIssueOpen(false);
    setLinkOpen(true);
    setLinkWorkId('');
    setActionError(null);
  }

  async function submitLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedItems.length === 0 || mixedProjects || !linkWorkId) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await linkBacklogItems(linkWorkId, selectedItems.map((item) => item.id));
      const target = linkWorks?.find((work) => work.id === linkWorkId);
      setOutcome({
        message: t('backlog.link.success', { count: String(selectedItems.length), number: String(target?.display_number ?? '—') }),
        workId: result.work_id,
      });
      setLinkOpen(false);
      setSelectedIds(new Set());
      setStatus(result.status);
      retry();
    } catch (error) {
      setActionError(classifyError(error));
      if (error instanceof ApiRequestError && ['invalid_state_transition', 'backlog_item_not_found', 'work_not_found', 'validation_error'].includes(error.code)) {
        setSelectedIds(new Set());
        setLinkOpen(false);
        retry();
      }
      console.error('[Owl] Backlog link failed', error);
    } finally {
      setBusy(false);
    }
  }

  function openIssueForm() {
    setLinkOpen(false);
    const draft = backlogWorkDraft(selectedItems, locale, t);
    setTitle(draft.title);
    setSummary(draft.summary);
    setSize('normal');
    setActionError(null);
    setIssueOpen(true);
  }

  async function submitIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedItems.length === 0 || mixedProjects) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await issueBacklogWork({
        item_ids: selectedItems.map((item) => item.id),
        title,
        summary,
        size,
      });
      setOutcome({
        message: t('backlog.issue.success', { number: String(result.display_number ?? result.work_id) }),
        workId: result.work_id,
      });
      setIssueOpen(false);
      setSelectedIds(new Set());
      setStatus('in_progress');
      retry();
    } catch (error) {
      setActionError(classifyError(error));
      if (error instanceof ApiRequestError && (error.code === 'invalid_state_transition' || error.code === 'backlog_item_not_found')) {
        setSelectedIds(new Set());
        setIssueOpen(false);
        retry();
      }
      console.error('[Owl] Backlog issue failed', error);
    } finally {
      setBusy(false);
    }
  }

  const currentLoadError = loadError || projectLoadError;

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('backlog.title')}</h1>
          <p className="page__sub">{t('backlog.subtitle')}</p>
        </div>
      </div>

      {outcome && (
        <div className="note" role="status">
          {outcome.message}{' '}
          {outcome.workId && (
            <Link href={`/work?id=${encodeURIComponent(outcome.workId)}`}>{t('backlog.issue.openWork')}</Link>
          )}
          <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => setOutcome(null)}>
            {t('common.close')}
          </button>
        </div>
      )}

      <section className="panel panel--tight">
        <div className="form-grid form-grid--filters">
          <label className="form-field form-field--short">
            <span>{t('backlog.filter.project')}</span>
            <select className="select" value={projectId} onChange={(event) => changeProject(event.target.value)} disabled={!projects}>
              <option value="">{t('backlog.filter.allProjects')}</option>
              {(projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label className="form-field form-field--short">
            <span>{t('backlog.filter.status')}</span>
            <select className="select" value={status} onChange={(event) => changeStatus(event.target.value)}>
              <option value="open">{t('backlog.status.open')}</option>
              <option value="in_progress">{t('backlog.status.in_progress')}</option>
              <option value="done">{t('backlog.status.done')}</option>
              <option value="dismissed">{t('backlog.status.dismissed')}</option>
              <option value="">{t('backlog.filter.allStatuses')}</option>
            </select>
          </label>
        </div>
      </section>

      {currentLoadError && (
        <div className="panel">
          <div className="error" role="alert">{t('backlog.loadError')}</div>
          <div className="btn-row mt-10">
            <button type="button" className="btn" onClick={retry}>{t('work.retry')}</button>
          </div>
        </div>
      )}

      {actionError && <div className="error" role="alert">{actionError}</div>}

      {items === null && !loadError && <p className="empty">{t('backlog.loading')}</p>}

      {selectedItems.length > 0 && (
        <section className="panel">
          <div className="btn-row">
            <span>{t('backlog.actions.selectedCount', { count: String(selectedItems.length) })}</span>
            <button type="button" className="btn btn--primary" disabled={busy || mixedProjects} onClick={openIssueForm}>
              {t('backlog.actions.issue')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={openLinkForm}>
              {t('backlog.actions.link')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void dismiss(selectedItems.map((item) => item.id))}>
              {t('backlog.actions.dismissSelected')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setSelectedIds(new Set()); setIssueOpen(false); setLinkOpen(false); }}>
              {t('backlog.actions.clearSelection')}
            </button>
          </div>
          {mixedProjects && <p className="note">{t('backlog.issue.mixedProjects')}</p>}
      {linkOpen && (
        <form className="form-grid mt-10" onSubmit={(event) => void submitLink(event)}>
          <h3 className="panel__title">{t('backlog.link.formTitle')}</h3>
          <label className="form-field">
            <span>{t('backlog.link.workLabel')}</span>
            <select className="select" value={linkWorkId} onChange={(event) => setLinkWorkId(event.target.value)} disabled={busy || !linkWorks} required>
              <option value="">{t('backlog.link.workPlaceholder')}</option>
              {(linkWorks ?? []).map((work) => (
                <option key={work.id} value={work.id}>
                  #{work.display_number ?? '—'} {work.title}（{t(`format.workState.${work.state}`)}）
                </option>
              ))}
            </select>
            {linkWorks?.length === 0 && <span className="note">{t('backlog.link.noCandidates')}</span>}
            <span className="note">{t('backlog.link.help')}</span>
          </label>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={() => setLinkOpen(false)}>{t('backlog.link.cancel')}</button>
            <button type="submit" className="btn btn--primary" disabled={busy || !linkWorkId || !linkWorks?.length}>{t('backlog.link.submit')}</button>
          </div>
        </form>
      )}
        </section>
      )}

      {issueOpen && (
        <form className="panel form-grid" onSubmit={(event) => void submitIssue(event)}>
          <h2 className="panel__title">{t('backlog.issue.formTitle')}</h2>
          <label className="form-field">
            <span>{t('backlog.issue.titleLabel')}</span>
            <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} required disabled={busy} />
          </label>
          <label className="form-field">
            <span>{t('backlog.issue.summaryLabel')}</span>
            <textarea className="textarea" value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={20000} rows={9} disabled={busy} />
          </label>
          <label className="form-field form-field--short">
            <span>{t('board.executionModeLabel')}</span>
            <select className="select" value={size} onChange={(event) => setSize(event.target.value as 'normal' | 'small')} disabled={busy}>
              <option value="normal">{t('board.managerPlan')}</option>
              <option value="small">{t('board.directWorker')}</option>
            </select>
            <span className="note">{t('board.executionModeHelp')}</span>
          </label>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy} onClick={() => setIssueOpen(false)}>{t('backlog.issue.cancel')}</button>
            <button type="submit" className="btn btn--primary" disabled={busy}>{t('backlog.issue.submit')}</button>
          </div>
        </form>
      )}

      {items !== null && items.length === 0 && !loadError && <p className="empty">{t('backlog.empty')}</p>}

      {items && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((item) => (
            <article className="card" key={item.id}>
              <div className="proposal-card__head">
                {item.status === 'open' && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggleSelection(item.id)}
                    disabled={busy}
                    aria-label={t('backlog.item.select')}
                  />
                )}
                <span className={`badge ${backlogStatusBadge(item.status)}`}>
                  {t(`backlog.status.${item.status}`)}
                </span>
                <span className="skill-card__name mono">{backlogLocation(item, t)}</span>
              </div>
              {item.project_name && <div className="row__sub">{item.project_name}</div>}
              <p><strong>{t('backlog.item.problem')}:</strong> {item.problem}</p>
              {item.reason && <p><strong>{t('backlog.item.reason')}:</strong> {item.reason}</p>}
              {item.suggestion && <p><strong>{t('backlog.item.suggestion')}:</strong> {item.suggestion}</p>}
              <div className="row__sub">
                {t('backlog.item.source')}:{' '}
                <Link href={`/work?id=${encodeURIComponent(item.work_id)}`}>
                  {item.work_display_number === null ? `Work ${item.work_title}` : `Work #${item.work_display_number} ${item.work_title}`}
                </Link>
                {' · '}Task {item.task_title}
              </div>
              {showsLinkedWork(item) && item.issued_work_id && (
                <div className="row__sub">
                  {t('backlog.item.linkedWork')}:{' '}
                  <Link href={`/work?id=${encodeURIComponent(item.issued_work_id)}`}>
                    {item.issued_work_display_number === null
                      ? item.issued_work_title ?? item.issued_work_id
                      : `#${item.issued_work_display_number} ${item.issued_work_title ?? ''}`}
                  </Link>
                </div>
              )}
              {item.status === 'open' && (
                <div className="btn-row mt-10">
                  <button type="button" className="btn" disabled={busy} onClick={() => void dismiss([item.id])}>{t('backlog.actions.dismiss')}</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
