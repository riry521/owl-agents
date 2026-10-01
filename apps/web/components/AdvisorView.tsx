'use client';

import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clearAdvisorConversation, getActiveConversation, getAdvisorSession, ingestConversation, listMessages, postMessage } from '@/lib/api-client';
import type { AdvisorSessionInfo, Message } from '@/lib/types';
import { formatClock, formatDateTime, formatRelative, newUlid } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { SendIcon } from '@/components/icons';

const POLL_INTERVAL_MS = 5_000;
const PENDING_POLL_INTERVAL_MS = 1_500;
const AWAITING_REPLY_TIMEOUT_MS = 60_000;

interface AwaitingReply {
  messageId: string;
  seenPending: boolean;
}

export function AdvisorView() {
  const { t, locale } = useLocale();
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
  const refreshSeqRef = useRef(0);
  const appliedMessagesSeqRef = useRef(0);
  const appliedSessionSeqRef = useRef(0);
  const [awaitingReply, setAwaitingReply] = useState<AwaitingReply | null>(null);

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
    const seq = ++refreshSeqRef.current;
    try {
      const list = await listMessages(id);
      if (revision !== clearRevisionRef.current || seq < appliedMessagesSeqRef.current) return;
      appliedMessagesSeqRef.current = seq;
      setMessages([...list].sort((a, b) => a.created_at.localeCompare(b.created_at)));
      setNow(Date.now());
      setLoadError(null);
    } catch (error) {
      console.error('[Owl] Advisor conversation load failed', error);
      setLoadError(humanizeLoadError(error, t));
    }
    try {
      const info = await getAdvisorSession(id);
      if (seq >= appliedSessionSeqRef.current) {
        appliedSessionSeqRef.current = seq;
        setSessionInfo(info);
      }
    } catch (error) {
      console.warn('[Owl] Advisor session status load failed', error);
    }
  }, [t]);

  const runningTurns = sessionInfo?.running_turns ?? 0;
  const queuedTurns = sessionInfo?.queued_turns ?? 0;
  const turnPending = runningTurns > 0 || queuedTurns > 0;
  const showIndicator = sending || awaitingReply !== null || turnPending;

  // The enqueue happens after the send request returns, so keep the indicator
  // up until the reply arrives, the turn is seen to finish, or nothing shows up.
  useEffect(() => {
    if (!awaitingReply) return;
    const sentIndex = messages?.findIndex((m) => m.id === awaitingReply.messageId) ?? -1;
    if (messages && sentIndex >= 0 && messages.slice(sentIndex + 1).some((m) => m.source === 'advisor')) {
      setAwaitingReply(null);
    } else if (turnPending && !awaitingReply.seenPending) {
      setAwaitingReply({ ...awaitingReply, seenPending: true });
    } else if (!turnPending && awaitingReply.seenPending) {
      setAwaitingReply(null);
    }
    // Evaluated once per refresh result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionInfo]);

  useEffect(() => {
    if (!awaitingReply || awaitingReply.seenPending) return;
    const timer = setTimeout(() => setAwaitingReply(null), AWAITING_REPLY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaitingReply]);

  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    void refresh(conversationId);
    const timer = setInterval(() => {
      if (alive) void refresh(conversationId);
    }, showIndicator ? PENDING_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversationId, refresh, showIndicator]);

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

  // Touching style.height mid-composition makes mobile IMEs drop the
  // unconfirmed text, so resize only outside composition and on its end.
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta || composingRef.current) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, []);

  useEffect(resizeTextarea, [draft, resizeTextarea]);

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
      const posted = await postMessage(conversationId, body);
      setAwaitingReply({ messageId: posted.message_id, seenPending: false });
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
      setAwaitingReply(null);
      await refresh(conversationId);
    } catch (error) {
      console.error('[Owl] Clear conversation failed', error);
      setClearError(t('advisor.errorClear'));
    }
  }

  const pausedUntil = sessionInfo?.provider_paused_until ?? null;
  const pausedClock = pausedUntil === null ? '—' : isToday(pausedUntil)
    ? formatClock(pausedUntil, locale)
    : formatDateTime(pausedUntil, locale);
  const indicatorLabel = sending || runningTurns > 0 || queuedTurns === 0
    ? t('advisor.thinking')
    : pausedUntil
      ? (pausedClock === '—'
        ? t('advisor.providerPaused')
        : t('advisor.providerPausedUntil', { time: pausedClock }))
      : t('advisor.waitingInQueue');

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
        {showIndicator && (
          <div className="turn turn--advisor">
            <div className="turn__content">
              <div className="turn__header">
                <span className="turn__dot turn__dot--advisor" />
                <span className="turn__name">{t('advisor.nameAdvisor')}</span>
              </div>
              <div className="turn__typing">
                <span /><span /><span />
                <em className="turn__typing-label">
                  {indicatorLabel}
                </em>
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
              onCompositionEnd={() => {
                composingRef.current = false;
                resizeTextarea();
              }}
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

/** Whether the timestamp falls on today's date in the viewer's local time. */
function isToday(iso: string): boolean {
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) && new Date(timestamp).toDateString() === new Date().toDateString();
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
