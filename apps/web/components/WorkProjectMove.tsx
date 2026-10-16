'use client';

import { useEffect, useState } from 'react';
import { listProjects, moveWorkToProject } from '@/lib/api-client';
import { useLocale } from '@/lib/i18n';
import { projectMoveErrorKey, workProjectMoveMode } from '../lib/work-project-move.mjs';
import type { Project } from '@/lib/types';

interface MovableWork {
  id: string;
  state: string;
  state_version: number;
  project_id: string | null;
  display_number?: number | null;
}

/**
 * Project row of Work detail. Stays mounted after a successful move so the
 * success notice survives the reload that gives the Work its project_id.
 */
export function WorkProjectMove({ work, onMoved }: { work: MovableWork; onMoved: () => void }) {
  const { t } = useLocale();
  const mode = workProjectMoveMode(work);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'move') return;
    let alive = true;
    listProjects().then((items) => {
      if (alive) setProjects(items);
    }).catch(() => {
      if (alive) setLoadFailed(true);
    });
    return () => { alive = false; };
  }, [mode]);

  const notice = success && <p className="note" role="status">{success}</p>;
  if (work.project_id) return <><span className="mono">{work.project_id}</span>{notice}</>;
  if (mode === 'none') return <>—</>;
  if (mode === 'pause-hint') return <>—<p className="note">{t('work.movePauseHint')}</p></>;

  const target = projects?.find((project) => project.id === selectedId) ?? projects?.[0];
  const move = async () => {
    if (!target || pending) return;
    const number = String(work.display_number ?? '');
    if (!window.confirm(t('work.moveConfirm', { number, project: target.name, path: target.canonical_path }))) return;
    setPending(true);
    setError(null);
    try {
      const result = await moveWorkToProject(work.id, work.state_version, target.id);
      setSuccess(t('work.moveSuccess', { project: target.name, number: String(result.display_number) }));
      onMoved();
    } catch (reason) {
      const e = (reason ?? {}) as { code?: unknown; details?: Record<string, unknown>; kind?: unknown };
      setError(t(projectMoveErrorKey(
        typeof e.code === 'string' ? e.code : '',
        e.details,
        typeof e.kind === 'string' ? e.kind : '',
      )));
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      {loadFailed && <p className="error" role="alert">{t('work.moveLoadError')}</p>}
      {projects?.length === 0 && <p className="note">{t('work.moveNoProjects')}</p>}
      {projects && projects.length > 0 && (
        <>
          <select
            aria-label={t('work.moveSelect')}
            value={target?.id ?? ''}
            disabled={pending}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{`${project.name} (${project.canonical_path})`}</option>
            ))}
          </select>{' '}
          <button type="button" className="btn" disabled={pending || !target} onClick={() => void move()}>
            {t('work.moveButton')}
          </button>
        </>
      )}
      {pending && <span className="note" role="status">{t('work.operationPending')}</span>}
      {notice}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
