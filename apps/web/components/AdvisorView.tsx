'use client';

import { type FormEvent, type KeyboardEvent, type Ref, useCallback, useEffect, useLayoutEffect, memo, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { clearAdvisorConversation, getAdvisorWindowConversation, getAdvisorSession, ingestConversation, listMessages, postMessage } from '@/lib/api-client';
import type { AdvisorSessionInfo, Message } from '@/lib/types';
import { formatClock, formatDateTime, formatRelative } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { AdvisorChannelPanel } from '@/components/AdvisorChannelPanel';
import { SendIcon } from '@/components/icons';
import { useView } from '@/lib/view-loader';
import { replyArrived } from '@/lib/advisor-awaiting.mjs';
import { DEFAULT_WINDOW_KEY, viaLabelKey } from '@/lib/advisor-windows.mjs';

const PENDING_POLL_INTERVAL_MS = 1_500;
const AWAITING_REPLY_TIMEOUT_MS = 60_000;
const RELATIVE_TIME_TICK_MS = 30_000;
// Turns rendered when a window opens; "show earlier" adds this many more. Each advisor turn parses Markdown.
const VISIBLE_MESSAGES_STEP = 30;

interface AwaitingReply {
  messageId: string;
}

interface AdvisorViewProps {
  // The window's conversation when the window list already knows it; skips the lookup request.
  knownConversationId?: string | null;
  windowKey?: string;
  // channelControls shows the channel button; only the Advisor page turns it on.
  channelControls?: boolean;
  // Omitting all of the props below keeps the Home/Board markup unchanged.
  windowName?: string;
  windowScope?: 'general' | 'project';
  // Only when given, the heading gets a window-name button (shown on narrow screens) that opens the picker sheet.
  onOpenWindowPicker?: () => void;
  windowPickerOpen?: boolean;
  windowTriggerRef?: Ref<HTMLButtonElement>;
}

export function AdvisorView({ windowKey = DEFAULT_WINDOW_KEY, knownConversationId = null, channelControls = false, windowName, windowScope, onOpenWindowPicker, windowPickerOpen = false, windowTriggerRef }: AdvisorViewProps = {}) {
  const { t, locale } = useLocale();
  const [visibleCount, setVisibleCount] = useState(VISIBLE_MESSAGES_STEP);
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
  // Both views poll while a reply is awaited: the enqueue lands after the send returns, so the session
  // can still read idle and nothing else would refresh them (the spinner then stalls or vanishes).
  const [awaitingReply, setAwaitingReply] = useState<AwaitingReply | null>(null);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const channelsButtonRef = useRef<HTMLButtonElement | null>(null);

  // No fallback id on failure: a conversation made up here would belong to no window.
  const conversationView = useView<string>(knownConversationId ? null : `advisor-window:${windowKey}`, () => getAdvisorWindowConversation(windowKey));
  const conversationId = knownConversationId ?? conversationView.data ?? null;

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

  const sessionView = useView<AdvisorSessionInfo>(
    conversationId ? `advisor-session:${conversationId}` : null,
    () => getAdvisorSession(conversationId ?? undefined),
    { refreshMs: (session) => ((session.running_turns ?? 0) > 0 || (session.queued_turns ?? 0) > 0 || awaitingReply !== null ? PENDING_POLL_INTERVAL_MS : null) },
  );
  const messagesView = useView<Message[]>(
    conversationId ? `advisor-messages:${conversationId}` : null,
    () => listMessages(conversationId ?? ''),
    { refreshMs: awaitingReply !== null || (sessionView.data?.running_turns ?? 0) > 0 || (sessionView.data?.queued_turns ?? 0) > 0 ? PENDING_POLL_INTERVAL_MS : null },
  );
  const sessionInfo = sessionView.data ?? null;
  const messages = useMemo(
    () => (messagesView.data ? [...messagesView.data].sort((a, b) => a.created_at.localeCompare(b.created_at)) : null),
    [messagesView.data],
  );
  const loadErrorSource = conversationView.error ?? messagesView.error;
  const loadError = loadErrorSource ? humanizeLoadError(loadErrorSource, t) : null;
  const refreshMessages = messagesView.refresh;
  const refreshSession = sessionView.refresh;
  const refresh = useCallback(async () => {
    await Promise.all([refreshMessages(), refreshSession()]);
  }, [refreshMessages, refreshSession]);

  useEffect(() => {
    if (messagesView.error) console.error('[Owl] Advisor conversation load failed', messagesView.error);
  }, [messagesView.error]);

  const runningTurns = sessionInfo?.running_turns ?? 0;
  const queuedTurns = sessionInfo?.queued_turns ?? 0;
  const turnPending = runningTurns > 0 || queuedTurns > 0;
  const showIndicator = sending || awaitingReply !== null || turnPending;

  // Only the reply (or the timeout) ends the wait: the turn is enqueued after the send returns, so an
  // idle or stale session says nothing about this send. A running turn keeps the indicator on past the timeout.
  useEffect(() => {
    if (replyArrived(awaitingReply, messages)) setAwaitingReply(null);
  }, [awaitingReply, messages]);

  useEffect(() => {
    if (!awaitingReply) return;
    const timer = setTimeout(() => setAwaitingReply(null), AWAITING_REPLY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaitingReply]);

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

  // Resolves true when the message was posted; false tells the composer to restore its draft.
  async function handleSend(text: string): Promise<boolean> {
    if (!conversationId) return false;
    const body = text.trim();
    if (!body) {
      setSendError(t('advisor.messageRequired'));
      return false;
    }
    setSending(true);
    setSendError(null);
    try {
      const posted = await postMessage(conversationId, body);
      setAwaitingReply({ messageId: posted.message_id });
      // Not awaited: the composer is already empty, and the reply is polled anyway.
      refresh().catch((error) => console.error('[Owl] Advisor refresh after send failed', error));
      return true;
    } catch (error) {
      console.error('[Owl] Advisor message send failed', error);
      setSendError(humanizeSendError(error, t));
      return false;
    } finally {
      setSending(false);
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
      setAwaitingReply(null);
      await refresh();
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

  if (!conversationId || messages === null) {
    return loadError ? <div className="advisor-error">{loadError}</div> : <p className="advisor-loading">{t('common.loading')}</p>;
  }

  return (
    <div className="advisor">
      <div className="advisor__header">
        <div className="advisor__header-left">
          <img src="/owl/icon.png" alt="Owl" className="advisor__header-icon" width={24} height={24} />
          <span className="advisor__header-title" title={windowName}>{windowName ?? t('advisor.title')}</span>
          {onOpenWindowPicker && (
            <button
              type="button"
              ref={windowTriggerRef}
              className="advisor__window-trigger"
              aria-haspopup="dialog"
              aria-expanded={windowPickerOpen}
              aria-label={t('advisorWindows.openPicker', { name: windowName ?? t('advisor.title') })}
              title={windowName}
              onClick={onOpenWindowPicker}
            >
              <span className="advisor__window-trigger-name">{windowName ?? t('advisor.title')}</span>
              <span className="advisor__window-trigger-caret" aria-hidden="true" />
            </button>
          )}
          {(sessionInfo || windowScope) && (
            <div className="advisor__session-badges" aria-label={t('advisor.sessionStatusLabel')}>
              {windowScope && (
                <span className={windowScope === 'project' ? 'badge badge--accent' : 'badge'}>
                  {t(windowScope === 'project' ? 'advisorWindows.scopeProject' : 'advisorWindows.scopeGeneral')}
                </span>
              )}
              {sessionInfo && (
                <>
                  {sessionInfo.model && (
                    <span className="advisor__session-badge advisor__session-badge--model">{sessionInfo.model}</span>
                  )}
                  <span className={`advisor__session-badge advisor__session-badge--${sessionInfo.status === 'suspended' ? 'suspended' : sessionInfo.status === 'none' ? 'none' : 'running'}`}>
                    {sessionStatusLabel(sessionInfo.status, t)}
                  </span>
                  <span className="advisor__session-badge">
                    {t('advisor.compactions', { count: String(sessionInfo.compaction_count ?? 0) })}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        {channelControls && (
          <button ref={channelsButtonRef} type="button" className="advisor__channels-button" aria-haspopup="dialog" aria-expanded={channelsOpen} onClick={() => setChannelsOpen(!channelsOpen)}>
            {t('advisorWindows.channelsButton')}
          </button>
        )}
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

      {channelControls && channelsOpen && (
        <AdvisorChannelPanel windowKey={windowKey} generalist={windowKey === DEFAULT_WINDOW_KEY} onClose={() => setChannelsOpen(false)} returnFocusTo={channelsButtonRef} />
      )}

      {knowledgeSaveNotice && <div className="note note--success">{knowledgeSaveNotice}</div>}
      {knowledgeSaveError && <div className="advisor-error">{knowledgeSaveError}</div>}
      {clearError && <div className="advisor-error">{clearError}</div>}
      {loadError && <div className="advisor-error">{loadError}</div>}

      <div ref={messagesRef} className="advisor__messages" onScroll={handleMessagesScroll}>
        {messages.length === 0 ? (
          <div className="advisor__empty">
            <div className="advisor__empty-icon"><img src="/owl/icon.png" alt="Owl" width={48} height={48} style={{ borderRadius: "10px" }} /></div>
            <h2>{windowName ?? t('advisor.title')}</h2>
            <p>{t('advisor.emptyMessage')}<br />{t('advisor.emptyHint')}</p>
          </div>
        ) : (
          <>
            {messages.length > visibleCount && (
              <button type="button" className="advisor__show-earlier" onClick={() => setVisibleCount((n) => n + VISIBLE_MESSAGES_STEP)}>
                {t('advisor.showEarlier')}
              </button>
            )}
            {messages.slice(-visibleCount).map((m) => (
              <Turn key={m.id} message={m} />
            ))}
          </>
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
        <AdvisorComposer sending={sending} sendError={sendError} isTouchDevice={isTouchDevice} onSend={handleSend} />
      </div>
    </div>
  );
}

// The input lives here, not in AdvisorView, so it never re-renders the conversation.
function AdvisorComposer({ sending, sendError, isTouchDevice, onSend }: {
  sending: boolean;
  sendError: string | null;
  isTouchDevice: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { t } = useLocale();
  // The text stays in the uncontrolled textarea; state only tracks empty vs. not, for the send button.
  const [hasText, setHasText] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const frameRef = useRef(0);
  // A ref, not the disabled prop: the textarea stays enabled so the draft clears at once.
  const sendingRef = useRef(false);

  // Touching style.height mid-composition makes mobile IMEs drop the
  // unconfirmed text, so resize only outside composition and on its end.
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta || composingRef.current) return;
    ta.style.height = '';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, []);

  // At most one measurement per frame: each one forces a layout of the whole page.
  // Browsers with field-sizing: content size the box themselves, so no JS runs there.
  const scheduleResize = useCallback(() => {
    if (typeof CSS !== 'undefined' && CSS.supports('field-sizing: content')) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(resizeTextarea);
  }, [resizeTextarea]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  async function send() {
    const ta = textareaRef.current;
    if (!ta || sendingRef.current) return;
    const text = ta.value;
    const clear = text.trim() !== '';
    sendingRef.current = true;
    if (clear) {
      ta.value = '';
      setHasText(false);
      scheduleResize();
    }
    let posted = false;
    try {
      posted = await onSend(text);
    } finally {
      sendingRef.current = false;
      ta.focus();
    }
    // Restore only into an empty box: text typed since the send is newer than the failed draft and must not be overwritten.
    if (!posted && clear && ta.value === '') {
      ta.value = text;
      setHasText(true);
      scheduleResize();
    }
  }

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    void send();
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    // Touch devices never send on a key; only the send button does. Desktop
    // sends on Shift+Enter and leaves plain Enter as a newline.
    if (isTouchDevice) return;
    if (ev.key === 'Enter' && ev.shiftKey && !composingRef.current && !ev.nativeEvent.isComposing && ev.nativeEvent.keyCode !== 229) {
      ev.preventDefault();
      void send();
    }
  }

  return (
    <form onSubmit={onSubmit} className="advisor__form">
      <div className="advisor__input-wrap">
        <textarea
          ref={textareaRef}
          className="advisor__textarea"
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => {
            composingRef.current = false;
            scheduleResize();
          }}
          onChange={(ev) => {
            const next = ev.target.value.trim() !== '';
            if (next !== hasText) setHasText(next);
            scheduleResize();
          }}
          onKeyDown={onKeyDown}
          placeholder={t('advisor.placeholder')}
          maxLength={100000}
          rows={2}
          enterKeyHint="enter"
        />
        <button
          type="submit"
          className="advisor__send"
          disabled={sending || !hasText}
          aria-label={t('advisor.sendLabel')}
        >
          <SendIcon />
        </button>
      </div>
      {sendError && <div className="advisor-error advisor-error--send">{sendError}</div>}
      <p className="advisor__hint">{t(isTouchDevice ? 'advisor.hintTouch' : 'advisor.hint')}</p>
    </form>
  );
}

// memo: AdvisorView re-renders on every poll; without it every turn re-parses its Markdown each time.
const Turn = memo(function Turn({ message }: { message: Message }) {
  const { t } = useLocale();
  const fromAdvisor = message.source === 'advisor';
  const viaKey = fromAdvisor ? null : viaLabelKey(message.source);
  return (
    <div className={`turn turn--${fromAdvisor ? 'advisor' : 'owner'}`}>
      <div className="turn__content">
        <div className="turn__header">
          <span className={`turn__dot turn__dot--${fromAdvisor ? 'advisor' : 'owner'}`} />
          <span className="turn__name">{fromAdvisor ? t('advisor.nameAdvisor') : t('advisor.nameYou') + (viaKey ? t(viaKey) : '')}</span>
          <span className="turn__time"><RelativeTime iso={message.created_at} /></span>
        </div>
        <div className={`turn__body${fromAdvisor ? '' : ' turn__body--plain'}`}>
          {fromAdvisor ? <MarkdownBody body={message.body} /> : message.body}
        </div>
      </div>
    </div>
  );
});

// Keyed on the body string, so a refetch that returns equal text never re-parses the Markdown.
const MarkdownBody = memo(function MarkdownBody({ body }: { body: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{body}</ReactMarkdown>;
});

// Owns the clock so ticking re-renders only this label, not the Turn around it.
function RelativeTime({ iso }: { iso: string }) {
  const { locale } = useLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return <>{formatRelative(iso, now, locale)}</>;
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
