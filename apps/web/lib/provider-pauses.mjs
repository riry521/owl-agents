/**
 * @typedef {object} ProviderPause
 * @property {string} provider
 * @property {string} label
 * @property {'paused' | 'probing'} state
 * @property {string} resume_at
 * @property {'reported' | 'backoff'} resume_source
 */

/**
 * @typedef {object} ProviderPauseLine
 * @property {string} provider
 * @property {string} label
 * @property {'paused' | 'probing'} state
 * @property {string} text
 */

/**
 * @param {ProviderPause[]} pauses
 * @param {(key: string, params?: Record<string, string>) => string} t
 * @param {Date | number} now
 * @param {string} [timeZone]
 * @returns {ProviderPauseLine[]}
 */
export function providerPauseLines(pauses, t, now, timeZone) {
  const current = now instanceof Date ? now : new Date(now);
  const locale = t('providerPause.timeLocale');
  return pauses.map((pause) => {
    if (pause.state === 'probing') {
      return {
        provider: pause.provider,
        label: pause.label,
        state: pause.state,
        text: t('providerPause.probing', { label: pause.label }),
      };
    }

    const resumeAt = new Date(pause.resume_at);
    const timeOptions = { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) };
    const dateOptions = { year: 'numeric', month: 'numeric', day: 'numeric', ...(timeZone ? { timeZone } : {}) };
    const resumeTime = new Intl.DateTimeFormat(locale, timeOptions).format(resumeAt);
    const currentDate = new Intl.DateTimeFormat(locale, dateOptions).format(current);
    const resumeDate = new Intl.DateTimeFormat(locale, dateOptions).format(resumeAt);
    const displayTime = currentDate === resumeDate
      ? resumeTime
      : `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(resumeAt)} ${resumeTime}`;
    const key = pause.resume_source === 'reported' ? 'providerPause.reported' : 'providerPause.backoff';
    return {
      provider: pause.provider,
      label: pause.label,
      state: pause.state,
      text: t(key, { label: pause.label, resumeTime: displayTime }),
    };
  });
}

/**
 * @template T
 * @param {() => Promise<T>} fetchPauses
 * @param {(pauses: T) => void} setPauses
 * @returns {Promise<void>}
 */
export async function refreshProviderPauses(fetchPauses, setPauses) {
  try {
    setPauses(await fetchPauses());
  } catch {
    // Keep the last known pause list until a later refresh succeeds.
  }
}
