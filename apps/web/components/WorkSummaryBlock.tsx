'use client';

import { useLocale } from '@/lib/i18n';
import { parseWorkSummary } from '../lib/work-summary.mjs';

/**
 * A Work summary laid out by the summary template (request / background /
 * approach / acceptance criteria / notes). `full` shows every section; `compact` shows the
 * request and the number of acceptance conditions. A summary that does not
 * use the template is shown as plain text with its line breaks kept.
 */
export function WorkSummaryBlock({ summary, variant }: { summary: string | null | undefined; variant: 'full' | 'compact' }) {
  const { locale, t } = useLocale();
  const parsed = parseWorkSummary(summary);
  if (!parsed.templated) {
    if (parsed.preamble.length === 0) return variant === 'full' ? <p className="wsum__text">—</p> : null;
    return <p className={variant === 'full' ? 'wsum__text' : 'wsum__text wsum__text--clamp'}>{parsed.preamble}</p>;
  }

  const request = parsed.sections.find((section) => section.key === 'request');
  if (variant === 'compact') {
    const acceptance = parsed.sections.find((section) => section.key === 'acceptance');
    const lead = request?.text || parsed.preamble;
    return (
      <div className="wsum wsum--compact">
        {lead && <p className="wsum__lead wsum__text--clamp">{lead}</p>}
        {acceptance && (
          <span className="wsum__count">{t('work.summaryAcceptanceCount', { count: String(acceptance.items.length) })}</span>
        )}
      </div>
    );
  }

  return (
    <div className="wsum">
      {parsed.preamble && <p className="wsum__text">{parsed.preamble}</p>}
      {parsed.sections.map((section) => {
        const label = locale === 'ja' ? section.label : section.label_en;
        if (section.key === 'request') {
          return (
            <section key={section.key} className="wsum__sec wsum__sec--request">
              <h3 className="wsum__label">{label}</h3>
              <p className="wsum__lead">{section.text}</p>
            </section>
          );
        }
        return (
          <section key={section.key} className={`wsum__sec wsum__sec--${section.key}`}>
            <h3 className="wsum__label">{label}</h3>
            {section.kind === 'list' ? (
              <ul className="wsum__checks">
                {section.items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="wsum__text">{section.text}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
