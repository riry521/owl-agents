'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  listKnowledge,
  searchKnowledge,
  getKnowledgeEntry,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  createRuleProposalFromNote,
} from '@/lib/api-client';
import type { KnowledgeEntry, KnowledgeSearchResult, RuleProposalRole } from '@/lib/types';
import { formatRelative } from '@/lib/format';
import { useLocale } from '@/lib/i18n';

type ViewMode = 'list' | 'view' | 'edit' | 'create';
type NoteClaim = { kind: string; text: string; fingerprint: string; sources: string[] };
type RelatedNote = { id: string; title: string };
type RulePromotion = { date: string; proposalId: string; status: 'applied' | 'rejected'; path: string };

const RULE_ROLES: RuleProposalRole[] = ['advisor', 'manager', 'designer', 'worker', 'reviewer', 'librarian', 'curator'];

function parseNoteBody(body: string) {
  const sections = new Map<string, string[]>();
  let section = '';
  for (const line of body.split(/\r?\n/u)) {
    const heading = line.match(/^## (.+)$/u);
    if (heading) {
      section = heading[1];
      sections.set(section, []);
    } else if (section) sections.get(section)?.push(line);
  }

  const claims: NoteClaim[] = [];
  for (const line of sections.get('Claims') ?? []) {
    const match = line.match(/^- \[(fact|decision|pitfall)\] (.*)$/u);
    if (!match) continue;
    let text = match[2];
    const marker = text.match(/\s+<!-- claim:([a-f0-9]{16}) sources:([^>]*) -->$/u);
    const fingerprint = marker?.[1] ?? '';
    const sources = marker?.[2].trim() ? marker[2].split(',').map((value) => value.trim()).filter(Boolean) : [];
    if (marker) text = text.slice(0, marker.index).trimEnd();
    if (text.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'string') text = parsed;
      } catch {
        // Keep displaying the original claim when legacy Markdown cannot be decoded.
      }
    }
    claims.push({ kind: match[1], text, fingerprint, sources });
  }

  const links = (sections.get('Related notes') ?? []).flatMap((line) => {
    const match = line.match(/^- \[\[([^\]|]+)\|([^\]]+)\]\]$/u);
    return match ? [{ id: match[1], title: match[2] }] : [];
  });
  const promotions = (sections.get('Rule promotion') ?? []).flatMap((line) => {
    const match = line.match(/^- (\S+) proposal (\S+) (applied|rejected) →(.*)$/u);
    return match ? [{ date: match[1], proposalId: match[2], status: match[3] as RulePromotion['status'], path: match[4].trim() }] : [];
  });
  const summary = (sections.get('Summary') ?? []).join('\n').trim();
  return { summary, claims, links, promotions };
}

function noteId(entry: KnowledgeEntry): string | null {
  if (entry.note_id !== undefined) {
    return typeof entry.note_id === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(entry.note_id)
      ? entry.note_id
      : null;
  }
  const id = (entry as KnowledgeEntry & { id?: unknown }).id;
  if (typeof id === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) return id;
  const frontmatterId = entry.body.match(/^id:\s*([0-9A-HJKMNP-TV-Z]{26})$/mu)?.[1];
  if (frontmatterId) return frontmatterId;
  const filenameId = entry.path.match(/(?:^|\/)([0-9A-HJKMNP-TV-Z]{26})\.md$/u)?.[1];
  return filenameId ?? null;
}

export function KnowledgeView() {
  const { locale, t } = useLocale();
  const [entries, setEntries] = useState<KnowledgeSearchResult[]>([]);
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ViewMode>('list');
  const [selected, setSelected] = useState<KnowledgeEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(Date.now());

  // Create/edit form state
  const [formFolder, setFormFolder] = useState('global');
  const [formFilename, setFormFilename] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formBody, setFormBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [promotionLevels, setPromotionLevels] = useState<Record<string, 'system' | 'role'>>({});
  const [promotionRoles, setPromotionRoles] = useState<Record<string, RuleProposalRole>>({});
  const [promotionStates, setPromotionStates] = useState<Record<string, { busy?: boolean; message?: string; error?: string }>>({});

  const folders = [
    { key: '', label: t('knowledge.folderAll') },
    { key: 'global', label: 'Global' },
    { key: 'projects', label: 'Projects' },
    { key: 'notes', label: 'Notes' },
  ];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = query
        ? await searchKnowledge(query)
        : await listKnowledge(folder || undefined);
      setEntries(results);
    } catch (e) {
      setError(t('knowledge.loadError'));
      console.error('[Owl] Knowledge load error', e);
    } finally {
      setLoading(false);
    }
  }, [folder, query, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSelect(path: string) {
    try {
      const entry = await getKnowledgeEntry(path);
      setSelected(entry);
      setMode('view');
    } catch {
      setError(t('knowledge.entryLoadError'));
    }
  }

  function handleEdit() {
    if (!selected) return;
    setFormTags(selected.tags.join(', '));
    setFormBody(selected.body);
    setMode('edit');
  }

  function handleNew() {
    setFormFolder('global');
    setFormFilename('');
    setFormTags('');
    setFormBody('');
    setMode('create');
  }

  async function handleSave(ev: FormEvent) {
    ev.preventDefault();
    setSaving(true);
    setError(null);
    const tags = formTags.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      if (mode === 'create') {
        const entry = await createKnowledgeEntry({
          folder: formFolder,
          filename: formFilename,
          tags,
          body: formBody,
        });
        setSelected(entry);
        setMode('view');
      } else if (mode === 'edit' && selected) {
        const entry = await updateKnowledgeEntry(selected.path, { tags, body: formBody });
        setSelected(entry);
        setMode('view');
      }
      void refresh();
    } catch (e) {
      setError(mode === 'create' ? t('knowledge.createError') : t('knowledge.updateError'));
      console.error('[Owl] Knowledge save error', e);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selected) return;
    try {
      await deleteKnowledgeEntry(selected.path);
      setSelected(null);
      setMode('list');
      void refresh();
    } catch {
      setError(t('knowledge.deleteError'));
    }
  }

  async function handleCreateRuleProposal(claim: NoteClaim) {
    if (!selected) return;
    const selectedNoteId = noteId(selected);
    if (!selectedNoteId) {
      setPromotionStates((previous) => ({ ...previous, [claim.fingerprint]: { error: t('knowledge.ruleProposalNoteIdUnavailable') } }));
      return;
    }
    const level = promotionLevels[claim.fingerprint] ?? 'system';
    setPromotionStates((previous) => ({ ...previous, [claim.fingerprint]: { busy: true } }));
    try {
      const result = await createRuleProposalFromNote({
        note_id: selectedNoteId,
        claim_fingerprint: claim.fingerprint,
        level,
        ...(level === 'role' ? { role: promotionRoles[claim.fingerprint] ?? 'worker' } : {}),
      });
      const message = t(`knowledge.ruleProposalResult.${result.status}`);
      setPromotionStates((previous) => ({
        ...previous,
        [claim.fingerprint]: {
          message,
          ...(result.last_error ? { error: result.last_error } : {}),
        },
      }));
      try {
        setSelected(await getKnowledgeEntry(selected.path));
      } catch (refreshError) {
        console.error('[Owl] Knowledge refresh after rule proposal failed', refreshError);
      }
    } catch (e) {
      setPromotionStates((previous) => ({
        ...previous,
        [claim.fingerprint]: { error: t('knowledge.ruleProposalError') },
      }));
      console.error('[Owl] Rule proposal creation error', e);
    }
  }

  if (mode === 'view' && selected) {
    const isNote = selected.path.startsWith('notes/');
    const note = isNote ? parseNoteBody(selected.body) : null;
    const noteSources = note ? [...new Set(note.claims.flatMap((claim) => claim.sources))].sort() : [];
    return (
      <>
        <div className="page__head">
          <div>
            <h1 className="page__title">{selected.title}</h1>
            <p className="page__sub">{selected.path}</p>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => { setMode('list'); setSelected(null); }}>{t('common.back')}</button>
            {!isNote && <button className="btn btn--primary" onClick={handleEdit}>{t('common.edit')}</button>}
            {!isNote && <button className="btn btn--danger" onClick={handleDelete}>{t('common.delete')}</button>}
          </div>
        </div>
        <section className="panel">
          <div className="kb-meta">
            {selected.tags.length > 0 && (
              <div className="kb-tags">
                {selected.tags.map((tg) => <span key={tg} className="kb-tag">{tg}</span>)}
              </div>
            )}
            <span className="kb-date">{t('knowledge.created')}: {selected.created} · {t('work.updated')}: {formatRelative(selected.mtime, now, locale)}</span>
          </div>
          {note ? (
            <div className="kb-body">
              <section className="rules-section">
                <h2 className="rules-section-title">{t('knowledge.noteSummary')}</h2>
                <p>{note.summary || t('knowledge.noteEmptySummary')}</p>
              </section>
              <section className="rules-section">
                <h2 className="rules-section-title">{t('knowledge.noteSources')}</h2>
                {noteSources.length > 0
                  ? <p>{noteSources.map((source) => <code key={source} style={{ marginRight: 8 }}>{source}</code>)}</p>
                  : <p className="empty">{t('knowledge.noteNoSources')}</p>}
              </section>
              <section className="rules-section">
                <h2 className="rules-section-title">{t('knowledge.noteClaims', { count: String(note.claims.length) })}</h2>
                {note.claims.length === 0 ? <p className="empty">{t('knowledge.noteNoClaims')}</p> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {note.claims.map((claim) => {
                      const level = promotionLevels[claim.fingerprint] ?? 'system';
                      const result = promotionStates[claim.fingerprint];
                      return (
                        <article key={claim.fingerprint || claim.text} className="card">
                          <div className="proposal-card__head">
                            <span className="badge badge--blue">{t(`knowledge.claimKind.${claim.kind}`)}</span>
                            {claim.fingerprint && <code>{claim.fingerprint}</code>}
                          </div>
                          <p>{claim.text}</p>
                          <div className="proposal-judgement__label">{t('knowledge.noteClaimSources')}</div>
                          <div className="proposal-judgement__value">
                            {claim.sources.length > 0 ? claim.sources.join(', ') : t('knowledge.noteNoSources')}
                          </div>
                          <div className="form-grid mt-10">
                            <label className="form-field">
                              <span>{t('knowledge.ruleProposalLevel')}</span>
                              <select
                                className="select"
                                value={level}
                                onChange={(event) => setPromotionLevels((previous) => ({ ...previous, [claim.fingerprint]: event.target.value as 'system' | 'role' }))}
                              >
                                <option value="system">{t('knowledge.ruleProposalSystem')}</option>
                                <option value="role">{t('knowledge.ruleProposalRole')}</option>
                              </select>
                            </label>
                            {level === 'role' && (
                              <label className="form-field">
                                <span>{t('knowledge.ruleProposalRoleLabel')}</span>
                                <select
                                  className="select"
                                  value={promotionRoles[claim.fingerprint] ?? 'worker'}
                                  onChange={(event) => setPromotionRoles((previous) => ({ ...previous, [claim.fingerprint]: event.target.value as RuleProposalRole }))}
                                >
                                  {RULE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                                </select>
                              </label>
                            )}
                          </div>
                          {result?.message && <div className="note" role="status">{result.message}</div>}
                          {result?.error && <div className="error" role="alert">{result.error}</div>}
                          <div className="btn-row mt-10">
                            <button
                              type="button"
                              className="btn btn--primary"
                              disabled={Boolean(result?.busy) || !claim.fingerprint}
                              onClick={() => void handleCreateRuleProposal(claim)}
                            >
                              {result?.busy ? t('knowledge.ruleProposalCreating') : t('knowledge.ruleProposalCreate')}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
              <section className="rules-section">
                <h2 className="rules-section-title">{t('knowledge.noteRelated')}</h2>
                {note.links.length > 0
                  ? <ul>{note.links.map((link) => <li key={link.id}>{link.title} <code>{link.id}</code></li>)}</ul>
                  : <p className="empty">{t('knowledge.noteNoRelated')}</p>}
              </section>
              <section className="rules-section">
                <h2 className="rules-section-title">{t('knowledge.noteRulePromotion')}</h2>
                {note.promotions.length > 0 ? (
                  <ul>
                    {note.promotions.map((promotion) => (
                      <li key={`${promotion.proposalId}:${promotion.date}`}>
                        {t(`knowledge.ruleProposalResult.${promotion.status}`)} · {promotion.date} · <code>{promotion.proposalId}</code>
                        {promotion.path && <> · <code>{promotion.path}</code></>}
                      </li>
                    ))}
                  </ul>
                ) : <p className="empty">{t('knowledge.noteNoPromotions')}</p>}
              </section>
            </div>
          ) : <div className="kb-body">{selected.body}</div>}
        </section>
      </>
    );
  }

  if (mode === 'create' || mode === 'edit') {
    return (
      <>
        <div className="page__head">
          <div>
            <h1 className="page__title">{mode === 'create' ? t('knowledge.newKnowledge') : t('common.edit')}</h1>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => setMode(selected ? 'view' : 'list')}>{t('common.cancel')}</button>
          </div>
        </div>
        <section className="panel">
          <form onSubmit={handleSave}>
            <div className="form-grid">
              {mode === 'create' && (
                <>
                  <label className="form-field">
                    <span>{t('knowledge.folderLabel')}</span>
                    <select className="select" value={formFolder} onChange={(e) => setFormFolder(e.target.value)}>
                      <option value="global">global</option>
                      <option value="projects">projects</option>
                    </select>
                  </label>
                  <label className="form-field">
                    <span>{t('knowledge.filenameLabel')}</span>
                    <input
                      className="input"
                      value={formFilename}
                      onChange={(e) => setFormFilename(e.target.value)}
                      placeholder="my-note"
                      required
                    />
                  </label>
                </>
              )}
              <label className="form-field">
                <span>{t('knowledge.tagsLabel')}</span>
                <input
                  className="input"
                  value={formTags}
                  onChange={(e) => setFormTags(e.target.value)}
                  placeholder={t('knowledge.tagsPlaceholder')}
                />
              </label>
              <label className="form-field">
                <span>{t('knowledge.bodyLabel')}</span>
                <textarea
                  className="textarea kb-editor"
                  value={formBody}
                  onChange={(e) => setFormBody(e.target.value)}
                  rows={16}
                  placeholder={t('knowledge.bodyPlaceholder')}
                />
              </label>
            </div>
            <div className="btn-row mt-14">
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
            {error && <div className="error mt-10">{error}</div>}
          </form>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="page__head">
        <div>
          <h1 className="page__title">{t('knowledge.title')}</h1>
          <p className="page__sub">{t('knowledge.subtitle')}</p>
        </div>
        <button className="btn btn--primary" onClick={handleNew}>{t('knowledge.newEntry')}</button>
      </div>

      <div className="kb-controls">
        <div className="pill-group">
          {folders.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`pill${folder === f.key ? ' pill--active' : ''}`}
              aria-pressed={folder === f.key}
              onClick={() => { setFolder(f.key); setQuery(''); }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="kb-search-wrap">
          <input
            className="input kb-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('knowledge.searchPlaceholder')}
          />
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p className="empty">{t('common.loading')}</p>
      ) : entries.length === 0 ? (
        <div className="kb-empty">
          <p className="empty">{t('knowledge.noEntries')}</p>
        </div>
      ) : (
        <div className="kb-list">
          {entries.map((e) => (
            <button key={e.path} className="kb-card" onClick={() => handleSelect(e.path)}>
              <div className="kb-card__header">
                <span className="kb-card__title">{e.title}</span>
                <span className="kb-card__time">{formatRelative(e.mtime, now, locale)}</span>
              </div>
              {e.tags.length > 0 && (
                <div className="kb-tags kb-tags--small">
                  {e.tags.map((tg) => <span key={tg} className="kb-tag">{tg}</span>)}
                </div>
              )}
              {e.snippet && <p className="kb-card__snippet">{e.snippet}</p>}
              <span className="kb-card__path">{e.path}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
