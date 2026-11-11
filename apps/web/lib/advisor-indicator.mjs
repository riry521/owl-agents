// @ts-check
/**
 * Whether the session still has something to show: a turn, a queued turn, or
 * an activity the driver reports. Drives the indicator and both polls.
 *
 * @param {{ running_turns?: number, queued_turns?: number, activity?: { state?: string | null, background_count?: number } | null } | null | undefined} session
 */
export function advisorSessionBusy(session) {
  const activity = session?.activity;
  return (session?.running_turns ?? 0) > 0
    || (session?.queued_turns ?? 0) > 0
    || (activity?.state ?? null) !== null
    || (activity?.background_count ?? 0) > 0;
}

/**
 * The indicator text: one main label by priority, plus the background count
 * when background work is running.
 *
 * @param {{ t: (key: string, params?: Record<string, string>) => string, session: { running_turns?: number, queued_turns?: number, activity?: { state?: string | null, tool_name?: string | null, background_count?: number } | null } | null | undefined, sending: boolean, stopping: boolean, pausedLabel: string | null }} args
 */
export function advisorIndicatorLabel({ t, session, sending, stopping, pausedLabel }) {
  const running = session?.running_turns ?? 0;
  const queued = session?.queued_turns ?? 0;
  const state = session?.activity?.state ?? null;
  const toolName = session?.activity?.tool_name ?? null;
  const background = session?.activity?.background_count ?? 0;

  let main;
  if (stopping) main = t('advisor.stopping');
  else if (state === 'tool' && toolName) main = t('advisor.activityTool', { tool: toolName });
  else if (state === 'subagent') main = t('advisor.activitySubagent');
  else if (state === 'thinking' || sending || running > 0) main = t('advisor.thinking');
  else if (queued > 0) main = pausedLabel ?? t('advisor.waitingInQueue');
  else if (background > 0) main = null;
  else main = t('advisor.thinking');

  if (background <= 0) return main;
  const backgroundLabel = t('advisor.activityBackground', { count: String(background) });
  return main === null ? backgroundLabel : t('advisor.activityWithBackground', { main, background: backgroundLabel });
}
