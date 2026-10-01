'use client';

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sendWorkInstruction } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { useLocale } from '@/lib/i18n';
import { SendIcon } from '@/components/icons';
import {
  humanizeInstructionError,
  instructionBadge,
  instructionBlock,
  latestInstructionSummary,
  messageRole,
  shouldSendOnKey,
} from '../lib/work-conversation.mjs';

/** Mirrors GET /works/{id}/conversation (design §2.4); kept local so this file does not depend on api-client types. */
export type WorkConversationMessage = {
  id: string;
  source: string;
  body: string;
  created_at: string;
  instruction?: { status: 'queued' | 'processing' | 'answered'; outcome: string | null; reply_message_id: string | null } | null;
  in_reply_to?: string[];
};

export type WorkConversationProps = {
  work: { id: string; state: string; state_version: number };
  /** 'page' = Work detail column, 'panel' = Board side panel. */
  variant: 'page' | 'panel';
  /** Conversation data owned (fetched/polled) by the parent; null while loading. */
  conversation: { messages: WorkConversationMessage[] } | null;
  /** Called after a send or a conflict so the parent reloads the Work and conversation. */
  onWorkChanged: () => void;
};

type Translate = (key: string, values?: Record<string, unknown>) => string;
type SendState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'failed'; messageKey: string };

export function WorkConversation({ work, variant, conversation, onWorkChanged }: WorkConversationProps) {
  const { locale, t } = useLocale() as { locale: 'ja' | 'en'; t: Translate };
  const [draft, setDraft] = useState('');
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const messagesRef = useRef<HTMLDivElement>(null);
  const followMessagesRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const composingEndTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const messages = conversation?.messages ?? [];
  const block = instructionBlock(work.state);
  const sending = sendState.kind === 'sending';
  const disabled = block.blocked || sending;
  const summary = latestInstructionSummary(messages, work.state);
  const processing = messages.some((m) => m.instruction?.status === 'processing');

  useEffect(() => {
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    setIsTouchDevice(query.matches);
    const handleChange = (ev: MediaQueryListEvent) => setIsTouchDevice(ev.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el || !followMessagesRef.current) return;
    // Scroll only this pane; scrollIntoView() would also move ancestors.
    const maxScrollTop = el.scrollHeight - el.clientHeight;
    if (maxScrollTop > el.scrollTop + 1) el.scrollTop = maxScrollTop;
  }, [conversation]);

  function resizeTextarea() {
    const ta = textareaRef.current;
    if (!ta || composingRef.current) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  // Touching the textarea mid-composition makes mobile IMEs commit the pending text.
  useEffect(resizeTextarea, [draft]);
  useEffect(() => () => clearTimeout(composingEndTimerRef.current), []);

  function handleMessagesScroll() {
    const el = messagesRef.current;
    if (!el) return;
    followMessagesRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 48;
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || disabled) return;
    if (block.reopen && !window.confirm(t(block.confirmKey ?? "work.instructionReopenConfirm"))) return;
    setSendState({ kind: 'sending' });
    try {
      await sendWorkInstruction(work.id, body, { reopen: block.reopen, expectedVersion: work.state_version });
      setDraft('');
      setSendState({ kind: 'idle' });
      followMessagesRef.current = true;
      onWorkChanged();
    } catch (error) {
      const { messageKey } = humanizeInstructionError(error as Parameters<typeof humanizeInstructionError>[0]);
      setSendState({ kind: 'failed', messageKey });
      onWorkChanged();
    }
  }

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    void handleSend();
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendOnKey(ev, { isTouchDevice, composing: composingRef.current })) {
      ev.preventDefault();
      void handleSend();
    }
  }

  return (
    <section className={`work-chat work-chat--${variant}`} aria-label={t('workChat.title')}>
      <div ref={messagesRef} className="work-chat__messages advisor__messages" onScroll={handleMessagesScroll}>
        {messages.length === 0 && <p className="work-chat__empty">{t('workChat.empty')}</p>}
        {messages.map((m) => (
          <ConversationTurn key={m.id} message={m} workState={work.state} now={now} locale={locale} t={t} />
        ))}
        {processing && (
          <div className="turn turn--manager">
            <div className="turn__content">
              <div className="turn__body"><span className="turn__typing"><span /><span /><span /></span> {t('workChat.processingTyping')}</div>
            </div>
          </div>
        )}
      </div>
      {summary && <p className="work-chat__status" role="status" aria-live="polite">{t('workChat.latestInstruction', { status: t(summary.labelKey) })}</p>}
      {block.blocked && <p className="work-chat__blocked">{t(block.reasonKey)}</p>}
      <div className="advisor__input-area work-chat__input-area">
        <form onSubmit={onSubmit} className="advisor__form">
          <div className="advisor__input-wrap">
            <textarea
              ref={textareaRef}
              className="advisor__textarea work-chat__textarea"
              onCompositionStart={() => {
                // A pending end-timer from the previous composition must not clear this one.
                clearTimeout(composingEndTimerRef.current);
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingEndTimerRef.current = setTimeout(() => { composingRef.current = false; resizeTextarea(); }, 50);
              }}
              value={draft}
              onChange={(ev) => {
                setDraft(ev.target.value);
                if (sendState.kind === 'failed') setSendState({ kind: 'idle' });
              }}
              onKeyDown={onKeyDown}
              placeholder={t('workChat.placeholder')}
              maxLength={100000}
              disabled={disabled}
              rows={2}
              enterKeyHint="enter"
            />
            <button type="submit" className="advisor__send" disabled={disabled || !draft.trim()} aria-label={t('workChat.send')}>
              <SendIcon />
            </button>
          </div>
          <p className="advisor__hint">{t(isTouchDevice ? 'workChat.hintTouch' : 'workChat.hint')}</p>
        </form>
        {sendState.kind === 'failed' && <p className="advisor-error work-chat__error" role="alert">{t(sendState.messageKey)}</p>}
      </div>
    </section>
  );
}

function ConversationTurn({ message, workState, now, locale, t }: {
  message: WorkConversationMessage;
  workState: string;
  now: number;
  locale: 'ja' | 'en';
  t: Translate;
}) {
  const role = messageRole(message) as 'owner' | 'manager' | 'advisor';
  const badge = role === 'owner' && message.instruction ? instructionBadge(message.instruction, workState) : null;
  const nameKey = role === 'owner' ? 'workChat.nameYou' : role === 'manager' ? 'workChat.nameManager' : 'workChat.nameAdvisor';
  return (
    <article className={`turn turn--${role}`}>
      <div className="turn__content">
        <div className="turn__header">
          <span className={`turn__dot turn__dot--${role}`} />
          <span className="turn__name">{t(nameKey)}</span>
          <span className="turn__time">{formatRelative(message.created_at, now, locale)}</span>
          {badge && <span className={`work-chat__badge work-chat__badge--${badge.tone}`}>{t(badge.labelKey)}</span>}
        </div>
        <div className={`turn__body${role === 'owner' ? ' turn__body--plain' : ''}`}>
          {role === 'owner' ? message.body : <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{message.body}</ReactMarkdown>}
        </div>
        {badge?.noteKey && <p className="work-chat__note">{t(badge.noteKey)}</p>}
      </div>
    </article>
  );
}
