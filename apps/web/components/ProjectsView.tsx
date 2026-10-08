'use client';

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiRequestError, browseProjectFolders, deleteProject, getActiveConversation, getProjectDeletionImpact, inspectProjectFolder, listProjects, postMessage, setupProject, updateProject } from '@/lib/api-client';
import type { DeleteProjectResult, Project, ProjectDeletionImpact, ProjectFolderBrowserResult, ProjectFolderInspection, ProjectRunningWork, ProjectSetupInput, UpdateProjectInput } from '@/lib/types';
import { buildProjectUpdateInput, deletionDialogModel, formatCommandLine, impactFromError, isProjectAutoPushEnabled, postMergeCommandPlaceholder, projectEditForm, projectErrorKey, type ProjectEditForm } from '@/lib/project-management';
import { workStateLabels } from '@/lib/format';
import { useLocale, type Locale, type TFunction } from '@/lib/i18n';

type RegistrationMode = 'existing' | 'new';
type PickerTarget = 'register' | 'edit';
const EMPTY_FORM = { name: '', path: '' };

export function ProjectsView() {
  const { t, locale } = useLocale();
  // t returns the key itself when missing, so an unknown reason falls back to the raw identifier.
  const testRunReasonLabel = (reason: string) => {
    const key = `projects.testRunReason_${reason}`;
    const label = t(key);
    return label === key ? reason : label;
  };
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ProjectEditForm>({ name: '', path: '', autoPush: false, setupCommand: '', refreshCommand: '', postMergeCommand: '', postMergeDisabled: false, installCommand: '', installDisabled: false });
  const [editError, setEditError] = useState<string | null>(null);
  const [editBlockImpact, setEditBlockImpact] = useState<ProjectDeletionImpact | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<ProjectDeletionImpact | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = useState<PickerTarget>('register');
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [projectNoticeError, setProjectNoticeError] = useState(false);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects();
      setProjects(list);
      setLoadError(null);
    } catch (error) {
      console.error('[Owl] Projects load failed', error);
      setLoadError(t(projectErrorKey(error, 'load')));
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
      setFormError(t(projectErrorKey(error, 'load')));
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
      setFormError(t(projectErrorKey(error, 'load')));
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
      setBrowseError(t(projectErrorKey(error, 'load')));
    } finally {
      setBrowseBusy(false);
    }
  }

  function openFolderBrowser(target: PickerTarget) {
    setPickerTarget(target);
    setBrowseOpen(true);
    void loadFolderBrowser(target === 'edit' ? editForm.path : undefined);
  }

  function startEdit(project: Project) {
    if (busyProjectId !== null || editingId !== null || deleteTarget !== null) return;
    setEditingId(project.id);
    setEditForm(projectEditForm(project));
    setEditError(null);
    setEditBlockImpact(null);
    setProjectNotice(null);
    setProjectNoticeError(false);
  }

  function cancelEdit() {
    if (busyProjectId !== null) return;
    setEditingId(null);
    setEditError(null);
    setEditBlockImpact(null);
  }

  async function saveEdit(ev: FormEvent<HTMLFormElement>, project: Project) {
    ev.preventDefault();
    const input: UpdateProjectInput | null | { error: 'nameRequired' | 'pathRequired' | 'commandInvalid' } = buildProjectUpdateInput(project, editForm);
    setEditBlockImpact(null);
    if (input === null) {
      setEditError(t('projects.editNoChanges'));
      return;
    }
    if ('error' in input) {
      setEditError(t(input.error === 'commandInvalid' ? 'projects.worktreeCommandInvalid' : 'projects.allFieldsRequired'));
      return;
    }

    setBusyProjectId(project.id);
    setEditError(null);
    setProjectNotice(null);
    setProjectNoticeError(false);
    try {
      await updateProject(project.id, input);
      setEditingId(null);
      setProjectNotice(t('projects.editSuccess'));
      setProjectNoticeError(false);
      await refresh();
    } catch (error) {
      console.error('[Owl] Project update failed', error);
      setEditBlockImpact(impactFromError(error));
      setEditError(t(projectErrorKey(error, 'edit')));
    } finally {
      setBusyProjectId(null);
    }
  }

  async function openDelete(project: Project) {
    if (busyProjectId !== null || editingId !== null || deleteTarget !== null) return;
    setBusyProjectId(project.id);
    setDeleteError(null);
    setDeleteTarget(null);
    setDeleteImpact(null);
    setProjectNotice(null);
    setProjectNoticeError(false);
    try {
      const impact = await getProjectDeletionImpact(project.id);
      setDeleteTarget(project);
      setDeleteImpact(impact);
    } catch (error) {
      console.error('[Owl] Project deletion impact load failed', error);
      if (isProjectError(error, 'project_not_found')) {
        setProjectNotice(t('projects.errorNotFound'));
        setProjectNoticeError(true);
        await refresh();
      } else {
        setProjectNotice(t(projectErrorKey(error, 'delete')));
        setProjectNoticeError(true);
      }
    } finally {
      setBusyProjectId(null);
    }
  }

  const closeDelete = useCallback(() => {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteImpact(null);
    setDeleteError(null);
  }, [deleteBusy]);

  async function confirmDelete() {
    if (!deleteTarget || !deleteImpact || deleteBusy) return;
    const project = deleteTarget;
    setDeleteBusy(true);
    setBusyProjectId(project.id);
    setDeleteError(null);
    setProjectNotice(null);
    setProjectNoticeError(false);
    try {
      const result: DeleteProjectResult = await deleteProject(project.id, deleteImpact.work_count);
      setDeleteTarget(null);
      setDeleteImpact(null);
      setProjectNotice(deleteImpact.work_count > 0
        ? t('projects.deleteSuccessWithWorks', { count: String(result.detached_work_count) })
        : t('projects.deleteSuccess'));
      setProjectNoticeError(false);
      await refresh();
    } catch (error) {
      console.error('[Owl] Project deletion failed', error);
      if (isProjectError(error, 'project_not_found')) {
        setDeleteTarget(null);
        setDeleteImpact(null);
        setDeleteError(null);
        setProjectNotice(t('projects.errorNotFound'));
        setProjectNoticeError(true);
        await refresh();
      } else {
        const latestImpact = impactFromError(error);
        if (latestImpact) setDeleteImpact(latestImpact);
        setDeleteError(t(projectErrorKey(error, 'delete')));
      }
    } finally {
      setDeleteBusy(false);
      setBusyProjectId(null);
    }
  }

  useEffect(() => {
    if (!deleteTarget) return;
    deleteCancelRef.current?.focus();
  }, [deleteTarget]);

  useEffect(() => {
    if (!deleteTarget) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !deleteBusy) {
        event.preventDefault();
        closeDelete();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteTarget, deleteBusy, closeDelete]);

  const isGitSetupAvailable = inspection &&
    (inspection.kind === 'not_git' || inspection.kind === 'git_needs_initial_commit') &&
    !inspection.truncated;
  const projectActionsDisabled = busyProjectId !== null || editingId !== null || deleteTarget !== null;
  const registerBusy = busy || projectActionsDisabled;
  const deletionModel = deleteImpact ? deletionDialogModel(deleteImpact) : null;

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('projects.title')}</h1>
          <p className="page__sub">{t('projects.subtitle')}</p>
        </div>
      </div>
      {projectNotice && <div className={`${projectNoticeError ? 'error' : 'note note--success'} mt-10`} role={projectNoticeError ? 'alert' : 'status'}>{projectNotice}</div>}
      {loadError && <div className="error mt-10">{loadError}</div>}

      <section className="panel" aria-labelledby="sec-create-project">
        <h2 className="panel__title" id="sec-create-project">{t('projects.addProject')}</h2>
        <div className="btn-row mt-10" role="group" aria-label={t('projects.registrationMode')}>
          <button type="button" className={`btn${mode === 'existing' ? ' btn--primary' : ''}`} aria-pressed={mode === 'existing'} onClick={() => changeMode('existing')} disabled={registerBusy}>
            {t('projects.useExisting')}
          </button>
          <button type="button" className={`btn${mode === 'new' ? ' btn--primary' : ''}`} aria-pressed={mode === 'new'} onClick={() => changeMode('new')} disabled={registerBusy}>
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
                disabled={registerBusy}
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
                disabled={registerBusy}
              />
                <button type="button" className="btn" onClick={() => openFolderBrowser('register')} disabled={registerBusy || browseBusy}>
                  {t('projects.browseFolders')}
                </button>
              </div>
            </div>
          </div>
          {mode === 'new' && <p className="note mt-10">{t('projects.newProjectGitNote')}</p>}
          <div className="btn-row mt-10">
            <button type="submit" className="btn btn--primary" disabled={registerBusy || (mode === 'existing' && inspection !== null && inspection.kind !== 'git_ready')}>
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
              <button type="button" className="btn" disabled={registerBusy || advisorBusy} onClick={() => void askAdvisorAboutGit()}>
                {advisorBusy ? t('common.loading') : t('projects.askAdvisor')}
              </button>
              <button type="button" className="btn btn--primary" disabled={registerBusy || inspection.truncated} onClick={() => void register('initialize_existing')}>
                {t('projects.gitSetupAndRegister')}
              </button>
              <button type="button" className="btn" disabled={registerBusy} onClick={() => { setInspection(null); setFormError(null); }}>
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
                  {editingId === project.id ? (
                    <form className="project-edit" onSubmit={(ev) => void saveEdit(ev, project)}>
                      <div className="form-grid">
                        <label className="form-field">
                          <span>{t('projects.nameLabel')}</span>
                          <input
                            className="input"
                            value={editForm.name}
                            onChange={(ev) => {
                              setEditForm((current) => ({ ...current, name: ev.target.value }));
                              setEditError(null);
                              setEditBlockImpact(null);
                            }}
                            maxLength={200}
                            disabled={busyProjectId !== null}
                          />
                        </label>
                        <div className="form-field">
                          <label htmlFor={`project-edit-path-${project.id}`}>{t('projects.folderLabel')}</label>
                          <div className="project-path-input">
                            <input
                              id={`project-edit-path-${project.id}`}
                              className="input mono"
                              value={editForm.path}
                              onChange={(ev) => {
                                setEditForm((current) => ({ ...current, path: ev.target.value }));
                                setEditError(null);
                                setEditBlockImpact(null);
                              }}
                              maxLength={4096}
                              disabled={busyProjectId !== null}
                            />
                            <button type="button" className="btn" onClick={() => openFolderBrowser('edit')} disabled={busyProjectId !== null || browseBusy}>
                              {t('projects.browseFolders')}
                            </button>
                          </div>
                        </div>
                      </div>
                      <p className="note">{t('projects.editPathNote')}</p>
                      <div className="form-row">
                        <span id={`auto-push-label-${project.id}`}>{t('projects.autoPushLabel')}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={editForm.autoPush}
                          aria-labelledby={`auto-push-label-${project.id}`}
                          className={`toggle-switch toggle-switch--${editForm.autoPush ? 'on' : 'off'}`}
                          onClick={() => setEditForm((current) => ({ ...current, autoPush: !current.autoPush }))}
                          disabled={busyProjectId !== null}
                        />
                        <p className="note">{t('projects.autoPushHelp')}</p>
                      </div>
                      <div className="form-grid">
                        <label className="form-field">
                          <span>{t('projects.worktreeSetupLabel')}</span>
                          <input
                            className="input mono"
                            value={editForm.setupCommand}
                            onChange={(ev) => {
                              setEditForm((current) => ({ ...current, setupCommand: ev.target.value }));
                              setEditError(null);
                            }}
                            placeholder={t('projects.worktreeCommandPlaceholder')}
                            maxLength={8192}
                            disabled={busyProjectId !== null}
                          />
                        </label>
                        <label className="form-field">
                          <span>{t('projects.worktreeRefreshLabel')}</span>
                          <input
                            className="input mono"
                            value={editForm.refreshCommand}
                            onChange={(ev) => {
                              setEditForm((current) => ({ ...current, refreshCommand: ev.target.value }));
                              setEditError(null);
                            }}
                            placeholder={t('projects.worktreeCommandPlaceholder')}
                            maxLength={8192}
                            disabled={busyProjectId !== null}
                          />
                        </label>
                        <label className="form-field">
                          <span>{t('projects.postMergeLabel')}</span>
                          <input
                            className="input mono"
                            value={editForm.postMergeCommand}
                            onChange={(ev) => {
                              setEditForm((current) => ({ ...current, postMergeCommand: ev.target.value }));
                              setEditError(null);
                            }}
                            placeholder={
                              postMergeCommandPlaceholder(project).kind === 'default'
                                ? t('projects.postMergeDefaultPlaceholder', { command: formatCommandLine(project.effective_post_merge_command ?? []) })
                                : t('projects.postMergePlaceholder')
                            }
                            maxLength={8192}
                            disabled={busyProjectId !== null || editForm.postMergeDisabled}
                          />
                        </label>
                        <label className="form-field">
                          <span>{t('projects.postMergeInstallLabel')}</span>
                          <input
                            className="input mono"
                            value={editForm.installCommand}
                            onChange={(ev) => {
                              setEditForm((current) => ({ ...current, installCommand: ev.target.value }));
                              setEditError(null);
                            }}
                            placeholder={t('projects.postMergeInstallPlaceholder')}
                            maxLength={8192}
                            disabled={busyProjectId !== null || editForm.installDisabled}
                          />
                        </label>
                        <div className="form-row">
                          <span id={`post-merge-install-disabled-label-${project.id}`}>{t('projects.postMergeInstallDisabledLabel')}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={editForm.installDisabled}
                            aria-labelledby={`post-merge-install-disabled-label-${project.id}`}
                            className={`toggle-switch toggle-switch--${editForm.installDisabled ? 'on' : 'off'}`}
                            onClick={() => setEditForm((current) => ({ ...current, installDisabled: !current.installDisabled }))}
                            disabled={busyProjectId !== null}
                          />
                        </div>
                        <div className="form-row">
                          <span id={`post-merge-disabled-label-${project.id}`}>{t('projects.postMergeDisabledLabel')}</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={editForm.postMergeDisabled}
                            aria-labelledby={`post-merge-disabled-label-${project.id}`}
                            className={`toggle-switch toggle-switch--${editForm.postMergeDisabled ? 'on' : 'off'}`}
                            onClick={() => setEditForm((current) => ({ ...current, postMergeDisabled: !current.postMergeDisabled }))}
                            disabled={busyProjectId !== null}
                          />
                        </div>
                      </div>
                      <p className="note">{t('projects.worktreeCommandsHelp')}</p>
                      <p className="note">{t('projects.postMergeHelp')}</p>
                      <p className="note">{t('projects.postMergeInstallHelp')}</p>
                      {editError && <div className="error" role="alert">{editError}</div>}
                      {editBlockImpact && <BlockingWorks impact={editBlockImpact} t={t} locale={locale} />}
                      <div className="btn-row">
                        <button type="submit" className="btn btn--primary" disabled={busyProjectId !== null}>
                          {busyProjectId === project.id ? t('common.saving') : t('common.save')}
                        </button>
                        <button type="button" className="btn" onClick={cancelEdit} disabled={busyProjectId !== null}>
                          {t('common.cancel')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="row__main">
                        <div className="row__title">
                          {project.name}
                          {isProjectAutoPushEnabled(project) && <span className="badge badge--accent">{t('projects.autoPushOn')}</span>}
                          {(project.effective_post_merge_command ?? []).length > 0 && (
                            <span className="badge badge--accent" title={formatCommandLine(project.effective_post_merge_command ?? [])}>{t('projects.postMergeOn')}</span>
                          )}
                        </div>
                        <div className="row__sub mono">{project.canonical_path}</div>
                        {project.test_run_status && (
                          <div className="row__sub">
                            {t(project.test_run_status.enabled ? 'projects.testRunOn' : 'projects.testRunOff', {
                              source: t(project.test_run_status.source === 'explicit' ? 'projects.testRunSourceExplicit' : 'projects.testRunSourceDetected'),
                            })}
                            {project.test_run_status.reason !== null && ` / ${t('projects.testRunReason', { reason: testRunReasonLabel(project.test_run_status.reason) })}`}
                            {project.test_run_status.command !== null && ` / ${t('projects.testRunCommand', { command: formatCommandLine(project.test_run_status.command) })}`}
                          </div>
                        )}
                      </div>
                      <div className="row__end">
                        <button type="button" className="btn btn--small" onClick={() => startEdit(project)} disabled={projectActionsDisabled} aria-label={t('projects.editAria', { name: project.name })}>
                          {t('common.edit')}
                        </button>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => void openDelete(project)} disabled={projectActionsDisabled} aria-label={t('projects.deleteAria', { name: project.name })}>
                          {busyProjectId === project.id ? t('common.loading') : t('common.delete')}
                        </button>
                      </div>
                    </>
                  )}
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
                      if (pickerTarget === 'edit') {
                        setEditForm((current) => ({ ...current, path: browseData.current_path }));
                        setEditError(null);
                        setEditBlockImpact(null);
                      } else {
                        changePath(browseData.current_path);
                      }
                      setBrowseOpen(false);
                    }}
                  >
                    {pickerTarget === 'register' && mode === 'new' ? t('projects.chooseParentFolder') : t('projects.chooseProjectFolder')}
                  </button>
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}

      {deleteTarget && deleteImpact && deletionModel && (
        <div className="folder-picker-backdrop" role="presentation" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) closeDelete(); }}>
          <section className="folder-picker panel" role="dialog" aria-modal="true" aria-labelledby="project-delete-title">
            <h2 className="panel__title" id="project-delete-title">{t('projects.deleteTitle')}</h2>
            {deleteError && <div className="error mt-10" role="alert">{deleteError}</div>}
            {deletionModel.variant === 'empty' && (
              <>
                <p className="mt-10">{t('projects.deleteConfirmEmpty', { name: deleteTarget.name })}</p>
                <p className="note mt-10">{t('projects.deleteKeepsFiles')}</p>
              </>
            )}
            {deletionModel.variant === 'withWorks' && (
              <>
                <p className="mt-10">{t('projects.deleteConfirmWithWorks', { name: deleteTarget.name, count: String(deletionModel.workCount) })}</p>
                {deletionModel.backlogCount > 0 && <p className="note mt-10">{t('projects.deleteBacklogNote', { count: String(deletionModel.backlogCount) })}</p>}
                <p className="note mt-10">{t('projects.deleteRenumberNote')}</p>
                <p className="note mt-10">{t('projects.deleteKeepsFiles')}</p>
              </>
            )}
            {deletionModel.variant === 'blocked' && (
              <>
                {!deleteError && <p className="error mt-10">{t('projects.deleteBlocked')}</p>}
                <BlockingWorks impact={deleteImpact} t={t} locale={locale} />
              </>
            )}
            <div className="btn-row btn-row--spaced">
              <button type="button" className="btn" onClick={closeDelete} disabled={deleteBusy} ref={deleteCancelRef}>
                {deletionModel.variant === 'blocked' ? t('common.close') : t('common.cancel')}
              </button>
              {deletionModel.variant !== 'blocked' && (
                <button type="button" className="btn btn--danger" onClick={() => void confirmDelete()} disabled={deleteBusy}>
                  {deleteBusy
                    ? t('projects.deleting')
                    : deletionModel.variant === 'withWorks'
                      ? t('projects.deleteWithWorks', { count: String(deletionModel.workCount) })
                      : t('projects.deleteConfirm')}
                </button>
              )}
            </div>
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

function BlockingWorks({
  impact,
  t,
  locale,
}: {
  impact: ProjectDeletionImpact;
  t: TFunction;
  locale: Locale;
}) {
  const model = deletionDialogModel(impact);
  if (model.variant !== 'blocked') return null;
  const labels = workStateLabels(locale);

  return (
    <div className="mt-10">
      <h3 className="panel__title">{t('projects.blockingWorksTitle')}</h3>
      {model.runningWorks.length > 0 && (
        <div className="list mt-10">
          {model.runningWorks.map((work: ProjectRunningWork) => (
            <div className="row" key={work.id}>
              <div className="row__main">
                <Link href={`/work?id=${encodeURIComponent(work.id)}`} className="row__title row__title--wrap">
                  {work.display_number === null ? '' : `#${work.display_number} `}{work.title}
                </Link>
              </div>
              <span className="note">{labels[work.state]}</span>
            </div>
          ))}
        </div>
      )}
      {model.hiddenRunningCount > 0 && <p className="note mt-10">{t('projects.blockingWorksMore', { count: String(model.hiddenRunningCount) })}</p>}
      {model.activeAgentCount > 0 && <p className="note mt-10">{t('projects.blockingAgents', { count: String(model.activeAgentCount) })}</p>}
    </div>
  );
}

function isProjectError(error: unknown, code: string): boolean {
  return error instanceof ApiRequestError
    ? error.code === code
    : error instanceof Error && error.message === code;
}
