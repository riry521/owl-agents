'use client';

import { type ComponentProps, type FormEvent,type KeyboardEvent, type Ref, useCallback, useEffect, useLayoutEffect, memo, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import { ownerFileAnchorProps, remarkOwnerFileLinks } from '@/lib/owner-file-links.mjs';
import remarkGfm from 'remark-gfm';
import { getOwnerFileRoots, clearAdvisorConversation, getAdvisorWindowConversation, getAdvisorSession, ingestConversation, interruptAdvisorTurn, listMessages, postMessage } from '@/lib/api-client';
import type { AdvisorSessionInfo, Message } from '@/lib/types';
import { formatClock, formatDateTime, formatRelative } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { AdvisorChannelPanel } from '@/components/AdvisorChannelPanel';
import { SendIcon, StopIcon, TrashIcon } from '@/components/icons';
import { useView } from '@/lib/view-loader';
import { replyArrived } from '@/lib/advisor-awaiting.mjs';
import { advisorIndicatorLabel, advisorSessionBusy } from '@/lib/advisor-indicator.mjs';
import { AttachButton, AttachmentTray, DropOverlay } from '@/components/AttachmentTray';
import { MessageAttachments } from '@/components/MessageAttachments';
import { useAttachmentDraft, useFileDrop } from '@/lib/use-attachment-draft';
import { blockedHintKey, canSend } from '@/lib/attachment-draft.mjs';
import { DEFAULT_WINDOW_KEY, readThroughToSend, viaLabelKey } from '@/lib/advisor-windows.mjs';
import { fileDeliveryView, isFileDeliveryMetadata } from '@/lib/advisor-file-delivery.mjs';
import { humanizeApiError } from '@/lib/api-error-keys.mjs';

const PENDING_POLL_INTERVAL_MS = 1_500;
const AWAITING_REPLY_TIMEOUT_MS = 60_000;
const RELATIVE_TIME_TICK_MS = 30_000;
const KNOWLEDGE_SAVE_NOTICE_MS = 5_000;
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
  // Called with the last Advisor reply on screen, each time a newer one is shown.
  onRepliesShown?: (lastReplyId: string) => void;
}

export function AdvisorView({ windowKey = DEFAULT_WINDOW_KEY, knownConversationId = null, channelControls = false, windowName, windowScope, onOpenWindowPicker, windowPickerOpen = false, windowTriggerRef, onRepliesShown }: AdvisorViewProps = {}) {
  const { t, locale } = useLocale();
  const [visibleCount, setVisibleCount] = useState(VISIBLE_MESSAGES_STEP);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
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
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current); }, []);

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
    { refreshMs: (session) => (advisorSessionBusy(session) || awaitingReply !== null ? PENDING_POLL_INTERVAL_MS : null) },
  );
  const messagesView = useView<Message[]>(
    conversationId ? `advisor-messages:${conversationId}` : null,
    () => listMessages(conversationId ?? ''),
    { refreshMs: awaitingReply !== null || advisorSessionBusy(sessionView.data) ? PENDING_POLL_INTERVAL_MS : null },
  );
  const sessionInfo = sessionView.data ?? null;
  const messages = useMemo(
    () => (messagesView.data ? [...messagesView.data].sort((a, b) => a.created_at.localeCompare(b.created_at)) : null),
    [messagesView.data],
  );
  const lastReplyId = readThroughToSend(messages, visibleCount);
  useEffect(() => {
    if (lastReplyId !== null) onRepliesShown?.(lastReplyId);
  }, [lastReplyId, onRepliesShown]);
  const loadErrorSource = conversationView.error ?? messagesView.error;
  const loadError = loadErrorSource ? humanizeApiError(loadErrorSource, t, LOAD_ERROR_KEYS) : null;
  const refreshMessages = messagesView.refresh;
  const refreshSession = sessionView.refresh;
  const refresh = useCallback(async () => {
    await Promise.all([refreshMessages(), refreshSession()]);
  }, [refreshMessages, refreshSession]);

  useEffect(() => {
    if (messagesView.error) console.error('[Owl] Advisor conversation load failed', messagesView.error);
  }, [messagesView.error]);

  const runningTurns = sessionInfo?.running_turns ?? 0;
  const showIndicator = sending || awaitingReply !== null || advisorSessionBusy(sessionInfo);

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
  async function handleSend(text: string, attachmentIds: string[]): Promise<boolean> {
    if (!conversationId) return false;
    const body = text.trim();
    if (!body && attachmentIds.length === 0) {
      setSendError(t('advisor.messageRequired'));
      return false;
    }
    setSending(true);
    setSendError(null);
    try {
      const posted = await postMessage(conversationId, body, attachmentIds);
      setAwaitingReply({ messageId: posted.message_id });
      // Not awaited: the composer is already empty, and the reply is polled anyway.
      refresh().catch((error) => console.error('[Owl] Advisor refresh after send failed', error));
      return true;
    } catch (error) {
      console.error('[Owl] Advisor message send failed', error);
      setSendError(humanizeApiError(error, t, SEND_ERROR_KEYS));
      return false;
    } finally {
      setSending(false);
    }
  }

  async function handleSaveSummary() {
    setMenuOpen(false);
    if (!conversationId || !messages || messages.length === 0) return;
    setKnowledgeSaving(true);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setKnowledgeSaveNotice(null);
    setKnowledgeSaveError(null);
    try {
      const result = await ingestConversation(conversationId);
      setKnowledgeSaveNotice(t('advisor.saveSuccess', { path: result.path }));
      noticeTimerRef.current = setTimeout(() => setKnowledgeSaveNotice(null), KNOWLEDGE_SAVE_NOTICE_MS);
    } catch (error) {
      console.error('[Owl] Save conversation to knowledge failed', error);
      setKnowledgeSaveError(humanizeApiError(error, t, KNOWLEDGE_ERROR_KEYS));
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

  async function handleStop() {
    setStopping(true);
    setStopError(null);
    try {
      await interruptAdvisorTurn(windowKey);
    } catch (error) {
      console.error('[Owl] Advisor interrupt failed', error);
      setStopError(t('advisor.errorStop'));
    }
    try {
      await refresh();
    } catch (error) {
      console.error('[Owl] Advisor refresh after stop failed', error);
    } finally {
      setStopping(false);
    }
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
  const pausedLabel = pausedUntil
    ? (pausedClock === '—'
      ? t('advisor.providerPaused')
      : t('advisor.providerPausedUntil', { time: pausedClock }))
    : null;
  const indicatorLabel = advisorIndicatorLabel({ t, session: sessionInfo, sending, stopping, pausedLabel });

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
        <div className="advisor__header-actions">
          <button type="button" className="advisor__kebab advisor__clear" onClick={handleClear} disabled={!conversationId} aria-label={t('advisor.menuClear')} title={t('advisor.menuClear')}>
            <TrashIcon />
          </button>
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
              </div>
            )}
          </div>
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
        <AdvisorComposer conversationId={conversationId} sending={sending} sendError={sendError} replying={runningTurns > 0} stopping={stopping} stopError={stopError} isTouchDevice={isTouchDevice} onSend={handleSend} onStop={handleStop} />
      </div>
    </div>
  );
}

// The input lives here, not in AdvisorView, so it never re-renders the conversation.
function AdvisorComposer({ conversationId, sending, sendError, replying, stopping, stopError, isTouchDevice, onSend, onStop }: {
  conversationId: string | null;
  sending: boolean;
  sendError: string | null;
  replying: boolean;
  stopping: boolean;
  stopError: string | null;
  isTouchDevice: boolean;
  onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useLocale();
  const draft = useAttachmentDraft({ kind: 'conversation', id: conversationId ?? '' });
  const { dragging, dropProps } = useFileDrop(draft.add, !conversationId);
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
    if (!ta || sendingRef.current || blockedHintKey(draft.items)) return;
    const text = ta.value;
    const attachmentIds = draft.attachmentIds;
    const clear = text.trim() !== '';
    sendingRef.current = true;
    if (clear) {
      ta.value = '';
      setHasText(false);
      scheduleResize();
    }
    let posted = false;
    try {
      posted = await onSend(text, attachmentIds);
    } finally {
      sendingRef.current = false;
      ta.focus();
    }
    if (posted) draft.clear();
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
    <form onSubmit={onSubmit} className="advisor__form" {...dropProps}>
      <DropOverlay visible={dragging} />
      <AttachmentTray items={draft.items} notices={draft.notices} onRemove={draft.remove} onRetry={draft.retry} onDismissNotices={draft.dismissNotices} />
      <div className="advisor__input-wrap">
        <AttachButton onFiles={draft.add} disabled={!conversationId} />
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
          onPaste={(ev) => {
            if (ev.clipboardData.files.length === 0) return;
            ev.preventDefault();
            draft.add(Array.from(ev.clipboardData.files));
          }}
          placeholder={t('advisor.placeholder')}
          maxLength={100000}
          rows={2}
          enterKeyHint="enter"
        />
        {replying ? (
          <button
            type="button"
            className="advisor__send advisor__send--stop"
            onClick={onStop}
            disabled={stopping}
            aria-label={t('advisor.stopLabel')}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="submit"
            className="advisor__send"
            disabled={!canSend({ body: hasText ? 'x' : '', items: draft.items, sending })}
            aria-label={t('advisor.sendLabel')}
          >
            <SendIcon />
          </button>
        )}
      </div>
      {sendError && <div className="advisor-error advisor-error--send">{sendError}</div>}
      {stopError && <div className="advisor-error advisor-error--send">{stopError}</div>}
      <p className="advisor__hint">{draft.hint ?? t(isTouchDevice ? 'advisor.hintTouch' : 'advisor.hint')}</p>
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
        {(fromAdvisor || message.body) && (
          <div className={`turn__body${fromAdvisor ? '' : ' turn__body--plain'}`}>
            {fromAdvisor ? <MarkdownBody body={message.body} /> : message.body}
          </div>
        )}
        {!fromAdvisor && <MessageAttachments attachments={message.attachments} />}
        {fromAdvisor && isFileDeliveryMetadata(message.metadata) && <FileDeliveryCard metadata={message.metadata} />}
      </div>
    </div>
  );
});

// Shows where Core sent (or refused to send) the files an Advisor reply asked for.
function FileDeliveryCard({ metadata }: { metadata: Message['metadata'] }) {
  const { t } = useLocale();
  const view = fileDeliveryView(metadata);
  const icon = view.state === 'pending' ? <span className="spinner" /> : { sent: '✓', failed: '!', unknown: '?', refused: '×' }[view.state];
  return (
    <section className={`delivery delivery--${view.state}`} aria-live="polite">
      <div className="delivery__head">
        <span className="delivery__icon" aria-hidden="true">{icon}</span>
        <span>
          {view.platform && (
            <span className="platform">
              <span className={`platform-dot platform-dot--${view.platform.provider ?? 'other'}`} aria-hidden="true" />
              {view.platform.label}
            </span>
          )}{' '}
          {t(view.headingKey, view.headingParams)}
        </span>
        {view.sourceKey && <span className="delivery__source">{t(view.sourceKey)}</span>}
      </div>
      {view.subKey && <p className="delivery__sub">{t(view.subKey, view.subParams)}</p>}
      {view.files.length > 0 && (
        <ul className="files">
          {view.files.map((file, index) => (
            <li key={index}>
              <span className="files__name">{file.size ? `${file.name} · ${file.size}` : file.name}</span>
              <span className={`files__status files__status--${file.status}`}>{t(file.statusKey)}</span>
              {file.reason && <span className="files__reason">{file.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {view.notice && <p className="delivery__notice">{view.notice}</p>}
      {view.settingsHref && (
        <div className="delivery__actions">
          <Link className="btn" href={view.settingsHref}>{t('advisor.fileDelivery.openSettings')}</Link>
        </div>
      )}
    </section>
  );
}

// Keyed on the body string, so a refetch that returns equal text never re-parses the Markdown.
// One fetch shared by every message; a failure is forgotten so a later render retries, and meanwhile replies show unconverted.
let ownerFileRootsPromise: ReturnType<typeof getOwnerFileRoots> | null = null;
function loadOwnerFileRoots() {
  ownerFileRootsPromise ??= getOwnerFileRoots().catch((error) => {
    ownerFileRootsPromise = null;
    throw error;
  });
  return ownerFileRootsPromise;
}

const MarkdownBody = memo(function MarkdownBody({ body }: { body: string }) {
  const [folders, setFolders] = useState<Awaited<ReturnType<typeof getOwnerFileRoots>> | null>(null);
  useEffect(() => {
    let active = true;
    loadOwnerFileRoots().then((value) => active && setFolders(value), () => undefined);
    return () => { active = false; };
  }, []);
  const apiBase = folders?.apiBase ?? '';
  const plugins = useMemo<NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>>(
    () => (folders && folders.roots.length > 0 ? [remarkGfm, [remarkOwnerFileLinks, { roots: folders.roots, apiBase }]] : [remarkGfm]),
    [folders, apiBase],
  );
  const components = useMemo<Components>(() => ({
    a: ({ href, children }: ComponentProps<'a'>) => <a href={href} {...ownerFileAnchorProps(href, apiBase)}>{children}</a>,
  }), [apiBase]);
  return <ReactMarkdown remarkPlugins={plugins} components={components} skipHtml>{body}</ReactMarkdown>;
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

const LOAD_ERROR_KEYS = {
  network: 'advisor.errorLoadNetwork',
  invalidResponse: 'advisor.errorLoadInvalid',
  fallback: 'advisor.errorLoadDefault',
};

const SEND_ERROR_KEYS = {
  validation: 'advisor.errorSendValidation',
  network: 'advisor.errorSendNetwork',
  invalidResponse: 'advisor.errorSendInvalid',
  fallback: 'advisor.errorSendDefault',
};

const KNOWLEDGE_ERROR_KEYS = {
  validation: 'advisor.errorSaveValidation',
  network: 'advisor.errorSaveNetwork',
  invalidResponse: 'advisor.errorSaveInvalid',
  fallback: 'advisor.errorSaveDefault',
  codes: { conversation_not_found: 'advisor.errorSaveValidation' },
};
