'use client';

import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clearAdvisorConversation, getActiveConversation, getAdvisorSession, ingestConversation, listMessages, postMessage } from '@/lib/api-client';
import type { AdvisorSessionInfo, Message } from '@/lib/types';
import { formatRelative, newUlid } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { SendIcon } from '@/components/icons';

const POLL_INTERVAL_MS = 5_000;

export function AdvisorView() {
  const { t } = useLocale();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [sessionInfo, setSessionInfo] = useState<AdvisorSessionInfo | null>(null);
  const [now, setNow] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeSaveNotice, setKnowledgeSaveNotice] = useState<string | null>(null);
  const [knowledgeSaveError, setKnowledgeSaveError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const followMessagesRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const clearRevisionRef = useRef(0);

  useEffect(() => {
    void getActiveConversation()
      .then((id) => setConversationId(id))
      .catch((error) => {
        console.error('[Owl] Failed to get active conversation', error);
        setConversationId(newUlid());
      });
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    setIsTouchDevice(query.matches);
    const handleChange = (ev: MediaQueryListEvent) => setIsTouchDevice(ev.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(ev: MouseEvent) {
      const target = ev.target as HTMLElement;
      if (!target.closest('.advisor__kebab-wrap')) setMenuOpen(false);
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuOpen]);

  const refresh = useCallback(async (id: string) => {
    const revision = clearRevisionRef.current;
    try {
      const list = await listMessages(id);
      if (revision !== clearRevisionRef.current) return;
      setMessages([...list].sort((a, b) => a.created_at.localeCompare(b.created_at)));
      setNow(Date.now());
      setLoadError(null);
    } catch (error) {
      console.error('[Owl] Advisor conversation load failed', error);
      setLoadError(humanizeLoadError(error, t));
    }
    try {
      setSessionInfo(await getAdvisorSession());
    } catch (error) {
      console.warn('[Owl] Advisor session status load failed', error);
    }
  }, [t]);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    void refresh(conversationId);
    const timer = setInterval(() => {
      if (alive) void refresh(conversationId);
    }, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversationId, refresh]);

  useLayoutEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement || !followMessagesRef.current) return;

    // Scroll only the conversation pane. scrollIntoView() also scrolls its
    // ancestors, which can pull the whole page back to the Advisor panel.
    const maxScrollTop = messagesElement.scrollHeight - messagesElement.clientHeight;
    if (maxScrollTop > messagesElement.scrollTop + 1) {
      messagesElement.scrollTop = maxScrollTop;
    }
  }, [messages]);

  function handleMessagesScroll() {
    const messagesElement = messagesRef.current;
    if (!messagesElement) return;
    const distanceFromBottom = messagesElement.scrollHeight - messagesElement.clientHeight - messagesElement.scrollTop;
    followMessagesRef.current = distanceFromBottom <= 48;
  }

  useEffect(() => {
    if (!textareaRef.current) return;
    const ta = textareaRef.current;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [draft]);

  async function handleSend() {
    if (!conversationId) return;
    const body = draft.trim();
    if (!body) {
      setSendError(t('advisor.messageRequired'));
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await postMessage(conversationId, body);
      setDraft('');
      await refresh(conversationId);
    } catch (error) {
      console.error('[Owl] Advisor message send failed', error);
      setSendError(humanizeSendError(error, t));
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function handleSaveSummary() {
    setMenuOpen(false);
    if (!conversationId || !messages || messages.length === 0) return;
    setKnowledgeSaving(true);
    setKnowledgeSaveNotice(null);
    setKnowledgeSaveError(null);
    try {
      const result = await ingestConversation(conversationId);
      setKnowledgeSaveNotice(t('advisor.saveSuccess', { path: result.path }));
    } catch (error) {
      console.error('[Owl] Save conversation to knowledge failed', error);
      setKnowledgeSaveError(humanizeKnowledgeError(error, t));
    } finally {
      setKnowledgeSaving(false);
    }
  }

  function handleExport() {
    setMenuOpen(false);
    if (!messages || messages.length === 0) return;
    const data = JSON.stringify(messages, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `advisor-${conversationId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleClear() {
    setMenuOpen(false);
    if (!conversationId) return;
    setClearError(null);
    try {
      await clearAdvisorConversation(conversationId);
      clearRevisionRef.current += 1;
      setMessages([]);
      await refresh(conversationId);
    } catch (error) {
      console.error('[Owl] Clear conversation failed', error);
      setClearError(t('advisor.errorClear'));
    }
  }

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    void handleSend();
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    // Touch devices never send on a key; only the send button does. Desktop
    // sends on Shift+Enter and leaves plain Enter as a newline.
    if (isTouchDevice) return;
    if (ev.key === 'Enter' && ev.shiftKey && !composingRef.current && !ev.nativeEvent.isComposing && ev.nativeEvent.keyCode !== 229) {
      ev.preventDefault();
      void handleSend();
    }
  }

  if (!conversationId || messages === null) {
    return loadError ? <div className="advisor-error">{loadError}</div> : <p className="advisor-loading">{t('common.loading')}</p>;
  }

  return (
    <div className="advisor">
      <div className="advisor__header">
        <div className="advisor__header-left">
          <img src="/owl/icon.png" alt="Owl" className="advisor__header-icon" width={24} height={24} />
          <span className="advisor__header-title">{t('advisor.title')}</span>
          {sessionInfo && (
            <div className="advisor__session-badges" aria-label={t('advisor.sessionStatusLabel')}>
              {sessionInfo.model && (
                <span className="advisor__session-badge advisor__session-badge--model">{sessionInfo.model}</span>
              )}
              <span className={`advisor__session-badge advisor__session-badge--${sessionInfo.status === 'suspended' ? 'suspended' : sessionInfo.status === 'none' ? 'none' : 'running'}`}>
                {sessionStatusLabel(sessionInfo.status, t)}
              </span>
              <span className="advisor__session-badge">
                {t('advisor.compactions', { count: String(sessionInfo.compaction_count ?? 0) })}
              </span>
            </div>
          )}
        </div>
        <div className="advisor__kebab-wrap">
          <button className="advisor__kebab" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">⋮</button>
          {menuOpen && (
            <div className="advisor__menu">
              <button className="advisor__menu-item" onClick={handleSaveSummary} disabled={knowledgeSaving}>
                <span className="advisor__menu-icon">📋</span>{t('advisor.menuSaveSummary')}
              </button>
              <button className="advisor__menu-item" onClick={handleExport}>
                <span className="advisor__menu-icon">📤</span>{t('advisor.menuExport')}
              </button>
              <button className="advisor__menu-item advisor__menu-item--danger" onClick={handleClear}>
                <span className="advisor__menu-icon">🗑</span>{t('advisor.menuClear')}
              </button>
            </div>
          )}
        </div>
      </div>

      {knowledgeSaveNotice && <div className="note note--success">{knowledgeSaveNotice}</div>}
      {knowledgeSaveError && <div className="advisor-error">{knowledgeSaveError}</div>}
      {clearError && <div className="advisor-error">{clearError}</div>}
      {loadError && <div className="advisor-error">{loadError}</div>}

      <div ref={messagesRef} className="advisor__messages" onScroll={handleMessagesScroll}>
        {messages.length === 0 ? (
          <div className="advisor__empty">
            <div className="advisor__empty-icon"><img src="/owl/icon.png" alt="Owl" width={48} height={48} style={{ borderRadius: "10px" }} /></div>
            <h2>{t('advisor.title')}</h2>
            <p>{t('advisor.emptyMessage')}<br />{t('advisor.emptyHint')}</p>
          </div>
        ) : (
          messages.map((m) => (
            <Turn key={m.id} message={m} now={now} />
          ))
        )}
        {sending && (
          <div className="turn turn--advisor">
            <div className="turn__content">
              <div className="turn__header">
                <span className="turn__dot turn__dot--advisor" />
                <span className="turn__name">{t('advisor.nameAdvisor')}</span>
              </div>
              <div className="turn__typing">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="advisor__input-area">
        <form onSubmit={onSubmit} className="advisor__form">
          <div className="advisor__input-wrap">
            <textarea
              ref={textareaRef}
              className="advisor__textarea"
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; }, 50); }}
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('advisor.placeholder')}
              maxLength={100000}
              disabled={sending}
              rows={2}
              enterKeyHint="enter"
            />
            <button
              type="submit"
              className="advisor__send"
              disabled={sending || !draft.trim()}
              aria-label={t('advisor.sendLabel')}
            >
              <SendIcon />
            </button>
          </div>
          {sendError && <div className="advisor-error advisor-error--send">{sendError}</div>}
          <p className="advisor__hint">{t(isTouchDevice ? 'advisor.hintTouch' : 'advisor.hint')}</p>
        </form>
      </div>
    </div>
  );
}

function Turn({ message, now }: { message: Message; now: number }) {
  const { locale, t } = useLocale();
  const fromAdvisor = message.source === 'advisor';
  return (
    <div className={`turn turn--${fromAdvisor ? 'advisor' : 'owner'}`}>
      <div className="turn__content">
        <div className="turn__header">
          <span className={`turn__dot turn__dot--${fromAdvisor ? 'advisor' : 'owner'}`} />
          <span className="turn__name">{fromAdvisor ? t('advisor.nameAdvisor') : t('advisor.nameYou')}</span>
          <span className="turn__time">{formatRelative(message.created_at, now, locale)}</span>
        </div>
        <div className={`turn__body${fromAdvisor ? '' : ' turn__body--plain'}`}>
          {fromAdvisor ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{message.body}</ReactMarkdown> : message.body}
        </div>
      </div>
    </div>
  );
}

function sessionStatusLabel(status: AdvisorSessionInfo['status'], t: (key: string) => string): string {
  if (status === 'suspended') return t('advisor.sessionSuspended');
  if (status === 'none') return t('advisor.sessionNone');
  return t('advisor.sessionRunning');
}

function humanizeLoadError(error: unknown, t: (key: string) => string): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('advisor.errorLoadNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('advisor.errorLoadInvalid');
    default:
      return t('advisor.errorLoadDefault');
  }
}

function humanizeSendError(error: unknown, t: (key: string) => string): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'validation_error':
      return t('advisor.errorSendValidation');
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('advisor.errorSendNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('advisor.errorSendInvalid');
    default:
      return t('advisor.errorSendDefault');
  }
}

function humanizeKnowledgeError(error: unknown, t: (key: string) => string): string {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'validation_error':
    case 'conversation_not_found':
      return t('advisor.errorSaveValidation');
    case 'network_error':
    case 'runtime_config_unavailable':
      return t('advisor.errorSaveNetwork');
    case 'invalid_runtime_config':
    case 'invalid_response':
      return t('advisor.errorSaveInvalid');
    default:
      return t('advisor.errorSaveDefault');
  }
}
