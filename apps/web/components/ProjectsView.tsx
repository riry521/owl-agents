'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { browseProjectFolders, getActiveConversation, inspectProjectFolder, listProjects, postMessage, setupProject } from '@/lib/api-client';
import type { Project, ProjectFolderBrowserResult, ProjectFolderInspection, ProjectSetupInput } from '@/lib/types';
import { useLocale } from '@/lib/i18n';

type RegistrationMode = 'existing' | 'new';
const EMPTY_FORM = { name: '', path: '' };

export function ProjectsView() {
  const { t } = useLocale();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<RegistrationMode>('existing');
  const [form, setForm] = useState(EMPTY_FORM);
  const [inspection, setInspection] = useState<ProjectFolderInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [advisorBusy, setAdvisorBusy] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseData, setBrowseData] = useState<ProjectFolderBrowserResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects();
      setProjects(list);
      setLoadError(null);
    } catch (error) {
      console.error('[Owl] Projects load failed', error);
      setLoadError(humanizeError(error, t));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function changeMode(next: RegistrationMode) {
    setMode(next);
    setInspection(null);
    setFormError(null);
    setFormNotice(null);
  }

  function changePath(path: string) {
    setForm((current) => ({ ...current, path }));
    setInspection(null);
    setFormError(null);
  }

  async function onInspect() {
    if (!form.path.trim()) {
      setFormError(t('projects.pathRequired'));
      return;
    }
    setBusy(true);
    setInspection(null);
    setFormError(null);
    setFormNotice(null);
    try {
      setInspection(await inspectProjectFolder(form.path.trim()));
    } catch (error) {
      console.error('[Owl] Project folder inspection failed', error);
      setFormError(humanizeError(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function register(modeToUse: ProjectSetupInput['mode']) {
    const name = form.name.trim();
    const path = (inspection && 'canonical_path' in inspection ? inspection.canonical_path : form.path).trim();
    if (!name || !path) {
      setFormError(t('projects.allFieldsRequired'));
      return;
    }
    setBusy(true);
    setFormError(null);
    setFormNotice(null);
    try {
      await setupProject({ mode: modeToUse, name, path });
      setForm(EMPTY_FORM);
      setInspection(null);
      setFormNotice(t('projects.createSuccess'));
      await refresh();
    } catch (error) {
      console.error('[Owl] Project creation failed', error);
      setFormError(humanizeError(error, t));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (mode === 'new') {
      await register('new');
      return;
    }
    if (!inspection) {
      await onInspect();
      return;
    }
    if (inspection.kind === 'git_ready') {
      await register('existing');
    }
  }

  async function askAdvisorAboutGit() {
    setAdvisorBusy(true);
    setFormError(null);
    try {
      const conversationId = await getActiveConversation();
      await postMessage(
        conversationId,
        '既存フォルダをOwl-AgentのProjectに追加しようとしていますが、Gitの変更履歴がありません。Gitに詳しくないユーザー向けに、Owlがローカルの変更履歴を作る意味、GitHubなどへ自動送信しないこと、初回の保存点に含めるファイルを確認してから作成することを簡潔に説明してください。最後に、Git管理を始めるか後で決めるかを尋ねてください。コマンド実行やファイル変更は行わないでください。',
      );
      router.push('/advisor');
    } catch (error) {
      console.error('[Owl] Advisor Git setup question failed', error);
      setFormError(t('projects.errorAdvisor'));
    } finally {
      setAdvisorBusy(false);
    }
  }

  async function loadFolderBrowser(path?: string) {
    setBrowseBusy(true);
    setBrowseError(null);
    try {
      setBrowseData(await browseProjectFolders(path));
    } catch (error) {
      console.error('[Owl] Project folder browser failed', error);
      setBrowseError(humanizeError(error, t));
    } finally {
      setBrowseBusy(false);
    }
  }

  function openFolderBrowser() {
    setBrowseOpen(true);
    void loadFolderBrowser();
  }

  const isGitSetupAvailable = inspection &&
    (inspection.kind === 'not_git' || inspection.kind === 'git_needs_initial_commit') &&
    !inspection.truncated;

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('projects.title')}</h1>
          <p className="page__sub">{t('projects.subtitle')}</p>
        </div>
      </div>
      {loadError && <div className="error mt-10">{loadError}</div>}

      <section className="panel" aria-labelledby="sec-create-project">
        <h2 className="panel__title" id="sec-create-project">{t('projects.addProject')}</h2>
        <div className="btn-row mt-10" role="group" aria-label={t('projects.registrationMode')}>
          <button type="button" className={`btn${mode === 'existing' ? ' btn--primary' : ''}`} aria-pressed={mode === 'existing'} onClick={() => changeMode('existing')} disabled={busy}>
            {t('projects.useExisting')}
          </button>
          <button type="button" className={`btn${mode === 'new' ? ' btn--primary' : ''}`} aria-pressed={mode === 'new'} onClick={() => changeMode('new')} disabled={busy}>
            {t('projects.makeNew')}
          </button>
        </div>
        <form onSubmit={onSubmit}>
          <div className="form-grid mt-10">
            <label className="form-field">
              <span>{t('projects.nameLabel')}</span>
              <input
                className="input"
                value={form.name}
                onChange={(ev) => setForm((current) => ({ ...current, name: ev.target.value }))}
                placeholder={t('projects.namePlaceholder')}
                maxLength={200}
                required
                disabled={busy}
              />
            </label>
            <div className="form-field">
              <label htmlFor="project-folder-path">{mode === 'new' ? t('projects.newFolderLabel') : t('projects.existingFolderLabel')}</label>
              <div className="project-path-input">
              <input
                id="project-folder-path"
                className="input"
                value={form.path}
                onChange={(ev) => changePath(ev.target.value)}
                placeholder={mode === 'new' ? t('projects.newFolderPlaceholder') : t('projects.existingFolderPlaceholder')}
                maxLength={4096}
                required
                disabled={busy}
              />
                <button type="button" className="btn" onClick={openFolderBrowser} disabled={busy || browseBusy}>
                  {t('projects.browseFolders')}
                </button>
              </div>
            </div>
          </div>
          {mode === 'new' && <p className="note mt-10">{t('projects.newProjectGitNote')}</p>}
          <div className="btn-row mt-10">
            <button type="submit" className="btn btn--primary" disabled={busy || (mode === 'existing' && inspection !== null && inspection.kind !== 'git_ready')}>
              {busy
                ? t('common.creating')
                : mode === 'new'
                  ? t('projects.createNewProject')
                  : inspection?.kind === 'git_ready'
                    ? t('projects.registerExisting')
                    : t('projects.checkFolder')}
            </button>
            {formNotice && <span className="note note--success">{formNotice}</span>}
          </div>
          {formError && <div className="error mt-10">{formError}</div>}
        </form>

        {inspection && <InspectionResult inspection={inspection} t={t} />}

        {isGitSetupAvailable && inspection && (
          <section className="panel panel--tight mt-10" aria-labelledby="git-setup-question">
            <h3 className="panel__title" id="git-setup-question">{t('projects.gitAdvisorTitle')}</h3>
            <p>{t('projects.gitAdvisorQuestion')}</p>
            <p className="note">{t('projects.gitAdvisorLocalOnly')}</p>
            <FilePreview inspection={inspection} t={t} />
            <div className="btn-row mt-10">
              <button type="button" className="btn" disabled={busy || advisorBusy} onClick={() => void askAdvisorAboutGit()}>
                {advisorBusy ? t('common.loading') : t('projects.askAdvisor')}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || inspection.truncated} onClick={() => void register('initialize_existing')}>
                {t('projects.gitSetupAndRegister')}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => { setInspection(null); setFormError(null); }}>
                {t('projects.decideLater')}
              </button>
            </div>
            {inspection.truncated && <p className="error mt-10">{t('projects.gitPreviewTooLarge')}</p>}
          </section>
        )}
      </section>

      <section className="section" aria-labelledby="sec-projects">
        <div className="section__head">
          <h2 className="section__title" id="sec-projects">{t('projects.projectList')}</h2>
          {projects && <span className="count">{t('common.items', { count: String(projects.length) })}</span>}
        </div>
        {!projects ? (
          <p className="empty">{t('common.loading')}</p>
        ) : projects.length === 0 ? (
          <p className="empty">{t('projects.noProjects')}</p>
        ) : (
          <div className="panel panel--tight">
            <div className="list">
              {projects.map((project) => (
                <div className="row" key={project.id}>
                  <div className="row__main">
                    <div className="row__title">{project.name}</div>
                    <div className="row__sub mono">{project.canonical_path}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {browseOpen && (
        <div className="folder-picker-backdrop" role="presentation" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) setBrowseOpen(false); }}>
          <section className="folder-picker panel" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
            <div className="folder-picker__head">
              <h2 className="panel__title" id="folder-picker-title">{t('projects.folderPickerTitle')}</h2>
              <button type="button" className="btn" onClick={() => setBrowseOpen(false)}>{t('common.cancel')}</button>
            </div>
            <p className="note">{t('projects.folderPickerHelp')}</p>
            {browseError && <div className="error mt-10">{browseError}</div>}
            {browseBusy ? (
              <p className="empty">{t('common.loading')}</p>
            ) : browseData ? (
              <>
                <div className="folder-picker__current mono">{browseData.current_path}</div>
                <div className="folder-picker__list" role="list">
                  {browseData.parent_path && (
                    <button type="button" className="folder-picker__item" onClick={() => void loadFolderBrowser(browseData.parent_path ?? undefined)}>
                      <span aria-hidden="true">↰</span><span>{t('projects.parentFolder')}</span>
                    </button>
                  )}
                  {browseData.folders.map((folder) => (
                    <button type="button" className="folder-picker__item" key={folder.path} onClick={() => void loadFolderBrowser(folder.path)}>
                      <span aria-hidden="true">📁</span><span>{folder.name}</span>
                    </button>
                  ))}
                  {browseData.folders.length === 0 && <p className="empty">{t('projects.noChildFolders')}</p>}
                </div>
                <div className="btn-row btn-row--spaced">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      changePath(browseData.current_path);
                      setBrowseOpen(false);
                    }}
                  >
                    {mode === 'new' ? t('projects.chooseParentFolder') : t('projects.chooseProjectFolder')}
                  </button>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </>
  );
}

function InspectionResult({ inspection, t }: { inspection: ProjectFolderInspection; t: (key: string, vars?: Record<string, string>) => string }) {
  if (inspection.kind === 'missing') return <p className="error mt-10">{t('projects.folderMissing')}</p>;
  if (inspection.kind === 'not_directory') return <p className="error mt-10">{t('projects.notAFolder')}</p>;
  if (inspection.kind === 'git_ready') {
    return (
      <div className="note note--success mt-10" role="status">
        {t('projects.gitDetected', { path: inspection.canonical_path, branch: inspection.base_branch })}
        {inspection.has_uncommitted_changes && ` ${t('projects.uncommittedNotice', { count: String(inspection.uncommitted_file_count) })}`}
      </div>
    );
  }
  return null;
}

function FilePreview({ inspection, t }: { inspection: Extract<ProjectFolderInspection, { kind: 'not_git' | 'git_needs_initial_commit' }>; t: (key: string, vars?: Record<string, string>) => string }) {
  return (
    <details className="mt-10">
      <summary>{t('projects.filePreviewSummary', { count: String(inspection.initial_files.length) })}</summary>
      <p className="note mt-10">{t('projects.filePreviewHelp')}</p>
      {inspection.initial_files.length === 0 ? (
        <p className="empty">{t('projects.noInitialFiles')}</p>
      ) : (
        <div className="project-file-preview mono" role="region" aria-label={t('projects.initialFilesList')}>
          <ul>
            {inspection.initial_files.map((file) => <li key={file}>{file}</li>)}
          </ul>
        </div>
      )}
      {inspection.excluded_files.length > 0 && (
        <>
          <p className="note mt-10">{t('projects.excludedFilesSummary', { count: String(inspection.excluded_files.length) })}</p>
          <div className="project-file-preview mono" role="region" aria-label={t('projects.excludedFilesList')}>
            <ul>
              {inspection.excluded_files.map((file) => <li key={file}>{file}</li>)}
            </ul>
          </div>
        </>
      )}
    </details>
  );
}

function humanizeError(error: unknown, t: (key: string) => string): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'validation_error':
      return t('projects.errorValidation');
    case 'project_path_conflict':
      return t('projects.errorDuplicate');
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('projects.errorNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('projects.errorInvalidResponse');
    default:
      return t('projects.errorDefault');
  }
}
